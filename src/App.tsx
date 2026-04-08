import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Coins, 
  Trophy, 
  Play, 
  LogOut, 
  LogIn, 
  User as UserIcon,
  RefreshCw,
  Target
} from 'lucide-react';
import { auth, db, loginWithGoogle, logout } from './firebase';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  limit, 
  onSnapshot, 
  serverTimestamp,
  getDocFromServer,
  doc
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

// --- Types ---

interface ScoreEntry {
  id: string;
  userId: string;
  userName: string;
  score: number;
  timestamp: any;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

// --- Constants ---

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PLAYER_SIZE = 40;
const COIN_SIZE = 30;
const BULLET_SIZE = 8;
const SPAWN_RATE = 1000; // ms

// --- Components ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [gameState, setGameState] = useState<'menu' | 'playing' | 'gameover'>('menu');
  const [score, setScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);
  const lastSpawnRef = useRef<number>(0);

  // Game Objects
  const playerRef = useRef({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - 60 });
  const bulletsRef = useRef<{ x: number; y: number }[]>([]);
  const coinsRef = useRef<{ x: number; y: number; speed: number }[]>([]);
  const keysRef = useRef<{ [key: string]: boolean }>({});

  // Error Handling
  const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
    const errInfo: FirestoreErrorInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
        isAnonymous: auth.currentUser?.isAnonymous,
        tenantId: auth.currentUser?.tenantId,
        providerInfo: auth.currentUser?.providerData.map(provider => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL
        })) || []
      },
      operationType,
      path
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
  };

  // --- Firebase Effects ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady) return;

    const q = query(collection(db, 'scores'), orderBy('score', 'desc'), limit(10));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: ScoreEntry[] = [];
      snapshot.forEach((doc) => {
        entries.push({ id: doc.id, ...doc.data() } as ScoreEntry);
      });
      setLeaderboard(entries);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'scores');
    });

    return () => unsubscribe();
  }, [isAuthReady]);

  // Test Connection
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  // --- Game Logic ---

  const startGame = () => {
    setScore(0);
    setGameState('playing');
    playerRef.current = { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT - 60 };
    bulletsRef.current = [];
    coinsRef.current = [];
    lastSpawnRef.current = performance.now();
  };

  const saveScore = async (finalScore: number) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'scores'), {
        userId: user.uid,
        userName: user.displayName || 'Anonymous',
        score: finalScore,
        timestamp: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'scores');
    }
  };

  const update = (time: number) => {
    if (gameState !== 'playing') return;

    // Player Movement
    const speed = 5;
    if (keysRef.current['ArrowLeft'] || keysRef.current['a']) playerRef.current.x -= speed;
    if (keysRef.current['ArrowRight'] || keysRef.current['d']) playerRef.current.x += speed;
    
    // Clamp player
    playerRef.current.x = Math.max(PLAYER_SIZE / 2, Math.min(CANVAS_WIDTH - PLAYER_SIZE / 2, playerRef.current.x));

    // Shooting
    if (keysRef.current[' '] || keysRef.current['ArrowUp'] || keysRef.current['w']) {
      // Limit fire rate
      const lastBullet = bulletsRef.current[bulletsRef.current.length - 1];
      if (!lastBullet || time - (lastBullet as any).time > 200) {
        const newBullet = { x: playerRef.current.x, y: playerRef.current.y - 20 };
        (newBullet as any).time = time;
        bulletsRef.current.push(newBullet);
      }
    }

    // Update Bullets
    bulletsRef.current = bulletsRef.current.filter(b => b.y > 0);
    bulletsRef.current.forEach(b => b.y -= 7);

    // Difficulty scaling: Start slower and increase based on score
    const difficultyMultiplier = 1 + (score / 300); // Increases every 300 points
    const minSpeed = 1.0 * difficultyMultiplier;
    const maxSpeed = 2.0 * difficultyMultiplier;

    // Spawn Coins
    if (time - lastSpawnRef.current > SPAWN_RATE) {
      coinsRef.current.push({
        x: Math.random() * (CANVAS_WIDTH - COIN_SIZE) + COIN_SIZE / 2,
        y: -COIN_SIZE,
        speed: minSpeed + Math.random() * (maxSpeed - minSpeed)
      });
      lastSpawnRef.current = time;
    }

    // Update Coins
    coinsRef.current.forEach(c => c.y += c.speed);
    
    // Collision Detection
    coinsRef.current.forEach((coin, cIdx) => {
      // Player collision
      const distToPlayer = Math.hypot(coin.x - playerRef.current.x, coin.y - playerRef.current.y);
      if (distToPlayer < (PLAYER_SIZE + COIN_SIZE) / 2) {
        setGameState('gameover');
        saveScore(score);
      }

      // Bullet collision
      bulletsRef.current.forEach((bullet, bIdx) => {
        const dist = Math.hypot(coin.x - bullet.x, coin.y - bullet.y);
        if (dist < (COIN_SIZE + BULLET_SIZE) / 2) {
          coinsRef.current.splice(cIdx, 1);
          bulletsRef.current.splice(bIdx, 1);
          setScore(s => s + 10);
        }
      });

      // Out of bounds
      if (coin.y > CANVAS_HEIGHT) {
        setGameState('gameover');
        saveScore(score);
      }
    });

    draw();
    requestRef.current = requestAnimationFrame(update);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Background Grid
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let i = 0; i < CANVAS_WIDTH; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let i = 0; i < CANVAS_HEIGHT; i += 40) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(CANVAS_WIDTH, i);
      ctx.stroke();
    }

    // Draw Player
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.moveTo(playerRef.current.x, playerRef.current.y - 20);
    ctx.lineTo(playerRef.current.x - 20, playerRef.current.y + 20);
    ctx.lineTo(playerRef.current.x + 20, playerRef.current.y + 20);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    // Draw Bullets
    ctx.fillStyle = '#facc15';
    bulletsRef.current.forEach(b => {
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Draw Coins
    ctx.fillStyle = '#fbbf24';
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 2;
    coinsRef.current.forEach(c => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, COIN_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      
      // Coin Detail
      ctx.fillStyle = '#d97706';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', c.x, c.y);
    });
  };

  useEffect(() => {
    if (gameState === 'playing') {
      requestRef.current = requestAnimationFrame(update);
    } else {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [gameState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent scrolling for game control keys
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
      keysRef.current[e.key] = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => keysRef.current[e.key] = false;
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // --- Render ---

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/10 p-4 flex justify-between items-center backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <div className="bg-blue-600 p-2 rounded-lg">
            <Target className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tighter uppercase">Coin Blaster</h1>
        </div>
        
        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <p className="text-xs text-white/50 font-mono uppercase">Logged in as</p>
                <p className="text-sm font-medium">{user.displayName}</p>
              </div>
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full border border-white/20" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                  <UserIcon className="w-4 h-4" />
                </div>
              )}
              <button 
                onClick={logout}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
                title="Logout"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <button 
              onClick={loginWithGoogle}
              className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-full font-medium hover:bg-white/90 transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Sign In
            </button>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Game Area */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="relative aspect-[4/3] bg-black rounded-2xl overflow-hidden border border-white/10 shadow-2xl shadow-blue-500/10">
            <canvas 
              ref={canvasRef} 
              width={CANVAS_WIDTH} 
              height={CANVAS_HEIGHT}
              className="w-full h-full object-contain"
            />

            <AnimatePresence>
              {gameState === 'menu' && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-8 text-center"
                >
                  <motion.div
                    initial={{ scale: 0.8, y: 20 }}
                    animate={{ scale: 1, y: 0 }}
                    className="bg-white/5 border border-white/10 p-12 rounded-3xl max-w-md"
                  >
                    <Coins className="w-20 h-20 text-yellow-400 mx-auto mb-6 animate-bounce" />
                    <h2 className="text-4xl font-black mb-4 tracking-tight">READY TO BLAST?</h2>
                    <p className="text-white/60 mb-8">
                      Use Arrow Keys or WASD to move and Space to shoot. 
                      Don't let the coins touch you or reach the bottom!
                    </p>
                    <button 
                      onClick={startGame}
                      className="group relative flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-2xl font-bold text-xl transition-all hover:scale-105 active:scale-95 mx-auto"
                    >
                      <Play className="w-6 h-6 fill-current" />
                      START GAME
                    </button>
                  </motion.div>
                </motion.div>
              )}

              {gameState === 'gameover' && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-red-950/80 backdrop-blur-md flex flex-col items-center justify-center p-8 text-center"
                >
                  <motion.div
                    initial={{ scale: 0.8, y: 20 }}
                    animate={{ scale: 1, y: 0 }}
                    className="bg-white/5 border border-white/10 p-12 rounded-3xl max-w-md"
                  >
                    <h2 className="text-6xl font-black mb-2 tracking-tighter text-red-500">GAME OVER</h2>
                    <div className="text-2xl font-mono mb-8 text-white/80">
                      FINAL SCORE: <span className="text-white font-bold">{score}</span>
                    </div>
                    
                    {!user && (
                      <p className="text-sm text-white/40 mb-6 italic">
                        Sign in to save your score to the leaderboard!
                      </p>
                    )}

                    <div className="flex flex-col gap-3">
                      <button 
                        onClick={startGame}
                        className="flex items-center justify-center gap-3 bg-white text-black px-8 py-4 rounded-2xl font-bold text-xl hover:bg-white/90 transition-all"
                      >
                        <RefreshCw className="w-6 h-6" />
                        TRY AGAIN
                      </button>
                      <button 
                        onClick={() => setGameState('menu')}
                        className="text-white/60 hover:text-white transition-colors"
                      >
                        Back to Menu
                      </button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* In-game HUD */}
            {gameState === 'playing' && (
              <div className="absolute top-6 left-6 flex items-center gap-4">
                <div className="bg-black/50 backdrop-blur-md border border-white/10 px-4 py-2 rounded-xl flex items-center gap-2">
                  <Target className="w-4 h-4 text-blue-400" />
                  <span className="font-mono text-xl font-bold">{score}</span>
                </div>
              </div>
            )}
          </div>

          {/* Controls Info */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap gap-4 justify-center text-sm text-white/60">
            <div className="flex items-center gap-2">
              <kbd className="bg-white/10 px-2 py-1 rounded border border-white/20 text-white font-mono">ARROWS</kbd>
              <span>Move & Shoot</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="bg-white/10 px-2 py-1 rounded border border-white/20 text-white font-mono">WASD</kbd>
              <span>Move & Shoot</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="bg-white/10 px-2 py-1 rounded border border-white/20 text-white font-mono">SPACE</kbd>
              <span>Shoot</span>
            </div>
          </div>
        </div>

        {/* Leaderboard */}
        <div className="flex flex-col gap-6">
          <div className="bg-white/5 border border-white/10 rounded-3xl p-6 flex flex-col h-full">
            <div className="flex items-center gap-3 mb-6">
              <Trophy className="w-6 h-6 text-yellow-400" />
              <h3 className="text-xl font-bold tracking-tight uppercase">Leaderboard</h3>
            </div>

            <div className="flex flex-col gap-2 overflow-y-auto max-h-[500px] pr-2 custom-scrollbar">
              {leaderboard.length > 0 ? (
                leaderboard.map((entry, index) => (
                  <motion.div 
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                    key={entry.id}
                    className={`flex items-center justify-between p-4 rounded-2xl border transition-all ${
                      user?.uid === entry.userId 
                        ? 'bg-blue-600/20 border-blue-500/50' 
                        : 'bg-white/5 border-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <span className={`font-mono font-bold text-lg w-6 ${
                        index === 0 ? 'text-yellow-400' : 
                        index === 1 ? 'text-gray-400' : 
                        index === 2 ? 'text-amber-600' : 'text-white/20'
                      }`}>
                        {index + 1}
                      </span>
                      <div>
                        <p className="font-bold leading-none mb-1">{entry.userName}</p>
                        <p className="text-[10px] text-white/30 font-mono uppercase">
                          {entry.timestamp?.toDate ? entry.timestamp.toDate().toLocaleDateString() : 'Just now'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-black text-blue-400">{entry.score}</p>
                    </div>
                  </motion.div>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-white/20">
                  <Trophy className="w-12 h-12 mb-4 opacity-10" />
                  <p className="text-sm italic">No scores yet. Be the first!</p>
                </div>
              )}
            </div>
          </div>

          {/* Tips Card */}
          <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-3xl p-6 relative overflow-hidden group">
            <div className="relative z-10">
              <h4 className="font-bold mb-2">PRO TIP</h4>
              <p className="text-sm text-white/80 leading-relaxed">
                Coins get faster as you score higher. Keep your distance and aim for the center!
              </p>
            </div>
            <Coins className="absolute -bottom-4 -right-4 w-24 h-24 text-white/10 rotate-12 group-hover:rotate-45 transition-transform duration-700" />
          </div>
        </div>
      </main>

      <footer className="mt-12 border-t border-white/10 p-8 text-center text-white/30 text-xs font-mono uppercase tracking-widest">
        &copy; 2026 Coin Blaster Arcade &bull; Powered by Google AI Studio
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
