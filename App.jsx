import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowUpRight, BadgeCheck, Bolt, Check, ChevronRight, CircleHelp, Copy, Crown, Eye, EyeOff, Gamepad2, Gem, LockKeyhole, Medal, Plus, Shield, ShieldCheck, Skull, Sparkles, Swords, Trophy, Users, Wallet, Wifi, WifiOff, Zap } from 'lucide-react';

const API = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const AVATARS = ['🦊','🐺','🦁','🐼','🐸','🐯','🦅','🐉'];
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [serverOffset, setServerOffset] = useState(0);
  const [screen, setScreen] = useState('home');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(0);
  const [joinCode, setJoinCode] = useState('');
  const [room, setRoom] = useState(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const [targetId, setTargetId] = useState('');
  const [timeLeft, setTimeLeft] = useState(15);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isSpectator, setIsSpectator] = useState(false);
  const [useDoubleSteal, setUseDoubleSteal] = useState(false);
  const [reaction, setReaction] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);

  useEffect(() => {
    const s = io(API, { transports: ['websocket', 'polling'], autoConnect: true, reconnection: true });
    setSocket(s);
    const sharedCode = new URLSearchParams(window.location.search).get('room');
    if (sharedCode) setJoinCode(sharedCode.toUpperCase().slice(0, 6));
    s.on('connect', () => { setConnected(true); const savedCode=localStorage.getItem('cc_room_code'); const savedId=localStorage.getItem('cc_player_id'); const savedName=localStorage.getItem('cc_player_name'); const savedAvatar=Number(localStorage.getItem('cc_avatar')||0); if(savedCode&&savedId&&savedName&&!sharedCode){ s.emit('room:join',{code:savedCode,playerId:savedId,name:savedName,avatar:savedAvatar}); } });
    s.on('disconnect', () => setConnected(false));
    s.on('room:joined', ({ code, playerId: id }) => {
      setIsSpectator(false); setPlayerId(id); localStorage.setItem('cc_player_id', id); localStorage.setItem('cc_room_code', code);
      setJoinCode(code); setScreen('lobby'); setBusy(false); setError('');
    });
    s.on('room:spectated', ({ code }) => { setIsSpectator(true); setPlayerId(''); setJoinCode(code); setScreen('playing'); setError(''); });
    s.on('room:reaction', data => { setReaction(data); if (navigator.vibrate) navigator.vibrate(35); setTimeout(() => setReaction(null), 2200); });
    s.on('room:update', data => {
      setServerOffset(data.serverNow - Date.now());
      setRoom(data);
      if (data.status === 'lobby') setScreen('lobby');
      if (data.status === 'playing') setScreen('playing');
      if (data.status === 'reveal') setScreen('reveal');
      if (data.status === 'finished') setScreen('finished');
      if (data.status === 'abandoned') { setScreen('lobby'); setError('The game paused because fewer than two players remain connected.'); }
    });
    s.on('action:locked', ({ type }) => { setPendingAction(type); setNotice('Action locked. Your choice is hidden until the round ends.'); });
    s.on('app:error', ({ message }) => { setError(message); setBusy(false); });
    s.on('room:closed', ({ message }) => { setError(message); leaveToHome(); });
    return () => s.disconnect();
  }, []);

  useEffect(() => {
    if (!room?.roundEndsAt || room.status !== 'playing') return;
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((room.roundEndsAt - (Date.now() + serverOffset)) / 1000)));
    tick(); const id = setInterval(tick, 150); return () => clearInterval(id);
  }, [room?.roundEndsAt, room?.status, serverOffset]);

  useEffect(() => { if (room?.status === 'playing' && !room?.myAction) setPendingAction(null); }, [room?.round, room?.status, room?.myAction]);

  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 3200); return () => clearTimeout(id); }, [notice]);

  useEffect(() => {
    if (!room?.reveal) return;
    const events = room.reveal.events || [];
    const actions = room.reveal.actions || [];
    const sounds = [
      ...(actions.some(action => action.type === 'collect') ? ['collect'] : []),
      ...(events.some(event => event.type === 'stolen') ? ['steal'] : []),
      ...(events.some(event => event.type === 'blocked') ? ['block'] : []),
    ];
    const timers = soundEnabled ? sounds.map((kind, index) => setTimeout(() => playGameTone(kind), index * 170)) : [];
    if (navigator.vibrate) navigator.vibrate([25, 20, 45]);
    return () => timers.forEach(clearTimeout);
  }, [room?.reveal, soundEnabled]);

  const me = room?.players?.find(p => p.id === playerId);
  const opponents = useMemo(() => (room?.players || []).filter(p => p.id !== playerId), [room, playerId]);
  const sorted = room?.players || [];
  const isHost = room?.hostId === playerId;
  const hasActed = Boolean(room?.myAction || (pendingAction && !['choose-target', 'choose-spy-target'].includes(pendingAction)));
  const actionLabel = room?.myAction?.type || pendingAction;

  function leaveToHome() {
    socket?.emit('room:leave');
    setRoom(null); setPlayerId(''); setIsSpectator(false); setScreen('home'); setPendingAction(null); localStorage.removeItem('cc_player_id'); localStorage.removeItem('cc_room_code'); localStorage.removeItem('cc_player_name'); localStorage.removeItem('cc_avatar');
  }
  function createRoom() {
    if (!name.trim()) return setError('Choose a player name to continue.');
    if (!socket?.connected) return setError('Connecting to the game server. Try again in a moment.');
    setBusy(true); setError(''); localStorage.setItem('cc_player_name',name.trim()); localStorage.setItem('cc_avatar',String(avatar)); socket.emit('room:create', { name, avatar });
  }
  function joinRoom() {
    if (!name.trim()) return setError('Choose a player name to continue.');
    if (joinCode.trim().length < 6) return setError('Enter the six-character room code.');
    if (!socket?.connected) return setError('Connecting to the game server. Try again in a moment.');
    setBusy(true); setError(''); localStorage.setItem('cc_player_name',name.trim()); localStorage.setItem('cc_avatar',String(avatar)); socket.emit('room:join', { code: joinCode, name, avatar, playerId: localStorage.getItem('cc_player_id') });
  }
  function submitAction(type, target = null, powerUp = null) {
    socket?.emit('game:action', { type, targetId: target, powerUp }); setPendingAction(type); setTargetId(''); setNotice('Your move is locked in.');
  }
  async function copyCode() { const link = `${window.location.origin}/?room=${room?.code || ''}`; try { await navigator.clipboard.writeText(link); setNotice('Invite link copied!'); } catch { setNotice('Room code: ' + room?.code); } }
  function watchRoom() { if (!joinCode.trim()) return setError('Enter the six-character room code to watch.'); socket?.emit('room:spectate', { code: joinCode }); }
  function addBot() { socket?.emit('game:add-bot'); }
  function sendReaction(emoji) { socket?.emit('room:reaction', { emoji }); if (navigator.vibrate) navigator.vibrate(25); }
  function startGame() { socket?.emit('game:start'); }
  function playAgain() { setPendingAction(null); socket?.emit('game:play-again'); }

  return <div className="app-shell">
    <div className="ambient ambient-one"/><div className="ambient ambient-two"/>
    <header className="topbar">
      <button className="brand" onClick={leaveToHome} aria-label="CASH CLASH home"><span className="brand-mark"><Gem size={20}/></span><span>CASH<span className="brand-gold">CLASH</span><small>THE MONEY MIND GAME</small></span></button>
      <div className="top-right"><span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? 'SERVER ONLINE' : 'CONNECTING'}</span><button className="icon-button" onClick={() => setSoundEnabled(v=>!v)} aria-label="Toggle sound">{soundEnabled?'♪':'♫̸'}</button><button className="icon-button" onClick={() => setRulesOpen(true)} aria-label="How to play"><CircleHelp size={18}/></button></div>
    </header>

    <main className="main-content">
      <AnimatePresence mode="wait">
        {screen === 'home' && <motion.section key="home" className="home-screen" initial={{opacity:0,y:14}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}}>
          <div className="hero-copy"><div className="eyebrow"><span className="eyebrow-line"/> STRATEGY. INSTINCT. CASH. <span className="eyebrow-line"/></div><h1>THINK FAST.<br/><em>PLAY SMART.</em><br/>TAKE THE CASH.</h1><p className="hero-sub">One room. Ten rounds. Eight players.<br/>Only one leaves on top.</p><div className="hero-stats"><div><Users size={16}/><b>2–8</b><span>PLAYERS</span></div><div><Bolt size={16}/><b>10</b><span>ROUNDS</span></div><div><Wallet size={16}/><b>$1,000</b><span>STARTING CASH</span></div></div></div>
          <motion.div className="entry-card" initial={{opacity:0,scale:.97}} animate={{opacity:1,scale:1}} transition={{delay:.12}}>
            <div className="card-topline"><span>ENTER THE ARENA</span><span className="live-dot">● LIVE GAME</span></div>
            <label className="field-label">YOUR PLAYER NAME</label><input className="text-input" maxLength={18} placeholder="Enter your alias..." value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&createRoom()}/>
            <label className="field-label avatar-label">CHOOSE YOUR AVATAR</label><div className="avatar-picker">{AVATARS.map((a,i)=><button key={a} className={`avatar-choice ${avatar===i?'selected':''}`} onClick={()=>setAvatar(i)}>{a}</button>)}</div>
            <button className="primary-button" disabled={busy} onClick={createRoom}><Plus size={18}/>{busy?'CREATING...':'CREATE A ROOM'}<ChevronRight size={18}/></button>
            <div className="or-divider"><span/> OR JOIN A CREW <span/></div>
            <div className="join-row"><input className="text-input code-input" maxLength={6} placeholder="ROOM CODE" value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&joinRoom()}/><button className="join-button" disabled={busy} onClick={joinRoom}>JOIN <ArrowUpRight size={16}/></button></div><button className="text-button watch-button" onClick={watchRoom}>WATCH AN ACTIVE GAME <Eye size={14}/></button>
            <div className="no-account"><LockKeyhole size={13}/> NO ACCOUNT. NO DOWNLOAD. JUST PLAY.</div>
          </motion.div>
          <div className="hero-footnote"><span>01 / OUTPLAY YOUR OPPONENTS</span><span>VIRTUAL CASH ONLY · FREE TO PLAY</span></div>
        </motion.section>}

        {screen === 'lobby' && room && <motion.section key="lobby" className="game-screen" initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
          <div className="screen-heading"><div><div className="eyebrow left"><span className="eyebrow-line"/> THE ARENA</div><h2>WAITING <em>ROOM</em></h2><p>Get your crew together. The host controls the start.</p></div><div className="room-code-box"><span>ROOM CODE · TAP TO SHARE</span><button onClick={copyCode}>{room.code}<Copy size={15}/></button></div></div>
          <div className="lobby-layout"><div className="panel players-panel"><div className="panel-heading"><span><Users size={17}/> PLAYERS IN LOBBY</span><b>{room.players.length}<small> / 8</small></b></div><div className="player-grid">{room.players.map((p,i)=><PlayerCard key={p.id} player={p} index={i} self={p.id===playerId}/ >)}{Array.from({length:Math.max(0,2-room.players.length)},(_,i)=><div className="empty-player" key={i}><Plus size={19}/><span>WAITING FOR PLAYER</span></div>)}</div><div className="invite-note"><Sparkles size={15}/> Share your room code with friends to fill the table.</div></div>
            <div className="panel start-panel"><div className="start-emblem"><Swords size={32}/></div><span className="mini-label">THE GAME IS ALMOST ON</span><h3>READY TO<br/><em>CLASH?</em></h3><p>10 rounds · 15 seconds each · $1,000 starting cash.</p>{isHost&&<button className="secondary-button" disabled={room.players.length>=8} onClick={addBot}>ADD AI OPPONENT <Plus size={15}/></button>}<button className="primary-button" disabled={!isHost || room.players.filter(p=>p.connected).length<2} onClick={startGame}>{isHost?'START GAME':'WAITING FOR HOST'}<ChevronRight size={18}/></button>{!isHost&&<span className="host-hint">The room host will start the game.</span>}{isHost&&room.players.length<2&&<span className="host-hint">At least 2 players are needed.</span>}<div className="lobby-rule"><ShieldCheck size={16}/> Every move stays secret until reveal.</div></div>
          </div>
        </motion.section>}

        {(screen === 'playing' || screen === 'reveal') && room && <motion.section key={screen+room.round} className="game-screen active-game" initial={{opacity:0,y:10}} animate={{opacity:1,y:0}}>
          <div className="game-topline"><div className="round-pill">ROUND <b>{String(room.round).padStart(2,'0')}</b><span>/ 10</span></div><div className="game-code">ROOM <b>{room.code}</b></div><div className="round-progress">{Array.from({length:10},(_,i)=><i key={i} className={i<room.round?'done':''}/>)}</div></div>
          {room.reconnecting?.length>0&&<div className="reconnect-banner"><WifiOff size={14}/>{room.reconnecting.map(p=>p.name).join(', ')} {room.reconnecting.length===1?'is':'are'} reconnecting…</div>}<div className="arena-heading"><div className="eyebrow"><span className="eyebrow-line"/> MAKE YOUR MOVE <span className="eyebrow-line"/></div><h2>{screen==='reveal'?'THE MOVES ARE IN.':'WHAT’S YOUR PLAY?'}</h2><p>{screen==='reveal'?'Actions revealed. Balances have been updated.':'Choose wisely. Nobody sees your action until the round ends.'}</p>{room.jackpot&&<div className="jackpot-banner">✦ JACKPOT ROUND · DOUBLE PAYOUTS ✦</div>}</div>
          {screen==='playing' && isSpectator ? <div className="locked-card spectator-card"><div className="locked-icon"><Eye size={24}/></div><h3>LIVE <em>SPECTATOR</em></h3><p>You are watching this match. You can react, but you cannot change the game.</p><div className="leader-list">{sorted.map((p,i)=><LeaderRow key={p.id} player={p} index={i}/>)}</div></div> : screen==='playing' ? <div className="play-layout"><div className="action-area"><div className={`timer-ring ${timeLeft<=5?'urgent':''}`}><div><strong>{timeLeft.toString().padStart(2,'0')}</strong><span>SECONDS</span></div></div>
            {!hasActed ? <>{me?.powerUps?.length>0&&<div className="powerup-inventory"><b>YOUR POWER-UPS</b>{me.powerUps.map(power=><span key={power}>{power==='double-steal'?'⚡ DOUBLE STEAL ×2':'👁 SPY INTEL'}</span>)}</div>}<div className="action-cards"><button className="action-card collect" onClick={()=>submitAction('collect')}><span className="action-icon"><Wallet size={25}/></span><b>COLLECT</b><strong>+{room.jackpot?200:100}</strong><small>Secure cash. Play it safe.</small><span className="action-cta">CHOOSE ACTION <ChevronRight size={14}/></span></button><button className="action-card steal" onClick={()=>setPendingAction('choose-target')}><span className="action-icon"><Skull size={25}/></span><b>STEAL</b><strong>+{room.jackpot?300:150}</strong><small>Pick a rival. Take their cash.</small><span className="action-cta">CHOOSE TARGET <ChevronRight size={14}/></span></button><button className="action-card protect" onClick={()=>submitAction('protect')}><span className="action-icon"><Shield size={25}/></span><b>PROTECT</b><strong>BLOCK</strong><small>Defend against every attack.</small><span className="action-cta">CHOOSE ACTION <ChevronRight size={14}/></span></button>{me?.powerUps?.includes('spy')&&<button className="action-card spy" onClick={()=>setPendingAction('choose-spy-target')}><span className="action-icon"><Eye size={25}/></span><b>SPY</b><strong>INTEL</strong><small>Peek at a rival’s last move.</small><span className="action-cta">USE POWER-UP <ChevronRight size={14}/></span></button>}</div>
            {(pendingAction==='choose-target'||pendingAction==='choose-spy-target')&&<div className="target-overlay"><div className="target-box"><button className="close-target" onClick={()=>setPendingAction(null)}>×</button><span className="mini-label">{pendingAction==='choose-spy-target'?'SPY INTELLIGENCE':'PICK YOUR TARGET'}</span><h3>{pendingAction==='choose-spy-target'?'WHO WILL YOU':'WHO’S GETTING'}<br/><em>{pendingAction==='choose-spy-target'?'INVESTIGATE?':'CLASHED?'}</em></h3><div className="target-list">{opponents.map(p=><button key={p.id} className={`target-option ${targetId===p.id?'chosen':''}`} onClick={()=>setTargetId(p.id)}><span>{AVATARS[p.avatar%AVATARS.length]}</span><b>{p.name}</b><small>{money(p.balance)}</small><ChevronRight size={16}/></button>)}</div>{pendingAction==='choose-target'&&me?.powerUps?.includes('double-steal')&&<button className={`secondary-button ${useDoubleSteal?'selected':''}`} onClick={()=>setUseDoubleSteal(v=>!v)}>{useDoubleSteal?'✓ DOUBLE STEAL ARMED':'USE DOUBLE STEAL ×2'}</button>}<button className="primary-button" disabled={!targetId} onClick={()=>{const spy=pendingAction==='choose-spy-target';submitAction(spy?'spy':'steal',targetId,useDoubleSteal&&!spy?'double-steal':null);setUseDoubleSteal(false);}}>{pendingAction==='choose-spy-target'?'REVEAL THEIR LAST MOVE':'LOCK IN STEAL'} <Swords size={17}/></button></div></div>}
            </> : <div className="locked-card"><div className="locked-icon"><EyeOff size={24}/></div><h3>MOVE <em>LOCKED IN</em></h3><p>Your {actionLabel==='choose-target'?'steal':actionLabel==='spy'?'spy':actionLabel} is hidden. Sit tight while the others decide.</p><div className="waiting-dots"><i/><i/><i/></div><span>WAITING FOR THE ROUND TO END</span></div>}
          </div><aside className="panel leaderboard"><div className="panel-heading"><span><Trophy size={16}/> LIVE STANDINGS</span><span className="live-tag">LIVE</span></div><div className="leader-list">{sorted.map((p,i)=><LeaderRow key={p.id} player={p} index={i} self={p.id===playerId}/>)}</div><div className="my-balance"><span>YOUR BALANCE</span><b>{money(me?.balance)}</b></div></aside></div> : <div className="reveal-layout"><div className="panel reveal-panel"><div className="reveal-title"><Sparkles size={18}/> ROUND {room.round} RESULTS</div><div className="reveal-list">{room.reveal?.actions?.map((a,i)=>{const p=room.players.find(x=>x.id===a.playerId);const target=room.players.find(x=>x.id===a.targetId);return <motion.div className="reveal-row" key={i} initial={{opacity:0,x:-18,rotateX:-35}} animate={{opacity:1,x:0,rotateX:0}} transition={{delay:i*.38,duration:.35}}><span className="reveal-avatar">{AVATARS[(p?.avatar||0)%AVATARS.length]}</span><b>{p?.name||'Player'}</b><span className={`reveal-action ${a.type}`}>{a.type.toUpperCase()}</span>{(a.type==='steal'||a.type==='spy')&&<small>→ {target?.name||'opponent'}</small>}</motion.div>})}</div><div className="event-feed">{room.reveal?.events?.map((e,i)=><motion.div key={i} initial={{opacity:0,y:12,scale:.96}} animate={{opacity:1,y:0,scale:1}} transition={{delay:.25+i*.2}} className={`event ${e.type}`}><motion.span animate={{y:[0,-8,0],rotate:[0,10,-10,0]}} transition={{duration:.7,delay:.3+i*.18}}>{e.type==='blocked'?'🛡️':'💸'}</motion.span>{room.players.find(p=>p.id===e.attackerId)?.name} {e.type==='blocked'?'was blocked by protection':`stole ${money(e.amount)} from ${room.players.find(p=>p.id===e.targetId)?.name}${e.bounty?` (+${money(e.bounty)} leader bounty)`:''}`}</motion.div>)}</div>{room.myIntel&&<div className="intel-note"><Eye size={14}/> Spy report: {room.players.find(p=>p.id===room.myIntel.targetId)?.name || 'Rival'} chose {room.myIntel.move.toUpperCase()} in round {room.myIntel.round}.</div>}<div className="recent-moves"><b>RIVAL MEMORY</b>{room.recentMoves?.slice(0,2).map(item=><div key={item.round}>R{item.round}: {item.actions.map(a=>`${room.players.find(p=>p.id===a.playerId)?.name||'Player'} ${a.type}`).join(' · ')}</div>)}</div><div className="next-round-note"><span className="pulse-dot"/> {room.round>=10?'FINAL RESULTS REVEAL':'NEXT ROUND STARTING SOON'}</div></div><aside className="panel leaderboard"><div className="panel-heading"><span><Trophy size={16}/> UPDATED STANDINGS</span></div><div className="leader-list">{sorted.map((p,i)=><LeaderRow key={p.id} player={p} index={i} self={p.id===playerId}/>)}</div><div className="my-balance"><span>YOUR BALANCE</span><b>{money(me?.balance)}</b></div></aside></div>}
        <div className="reaction-bar">{['😂','😱','🔥','👏','💀','🛡️'].map(emoji=><button key={emoji} onClick={()=>sendReaction(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}</div>{reaction&&<motion.div className="floating-reaction" initial={{opacity:0,y:15,scale:.6}} animate={{opacity:1,y:-20,scale:1}} exit={{opacity:0}}>{reaction.spectator?'Spectator':room.players.find(p=>p.id===reaction.playerId)?.name||'Player'} {reaction.emoji}</motion.div>}</motion.section>}

        {screen === 'finished' && room && <motion.section key="finished" className="finish-screen" initial={{opacity:0,scale:.97}} animate={{opacity:1,scale:1}}><div className="finish-confetti">✦　✧　✦　✧　✦</div><div className="eyebrow"><span className="eyebrow-line"/> GAME OVER <span className="eyebrow-line"/></div><div className="trophy-large"><Trophy size={46}/></div><span className="mini-label">THE CASH CLASH CHAMPION</span><h1>{room.winner?.name || 'WINNER'}<br/><em>TAKES THE POT.</em></h1><div className="winner-cash">{money(room.winner?.balance)}</div><p className="finish-sub">Ten rounds. One champion. What a clash.</p><div className="final-board panel"><div className="panel-heading"><span><Medal size={16}/> FINAL LEADERBOARD</span><span>10 / 10 ROUNDS</span></div>{sorted.map((p,i)=><LeaderRow key={p.id} player={p} index={i} self={p.id===playerId}/>)}</div>{room.awards?.length>0&&<div className="awards-grid">{room.awards.map(award=><div className="award-card" key={award.title}><span>{award.title}</span><b>{room.players.find(p=>p.id===award.playerId)?.name||'Player'}</b><small>{award.title==='MOST STEALS'?`${award.value} steals`:award.title==='MOST BLOCKED'?`${award.value} blocks`:`${money(award.value)} swing`}</small></div>)}</div>}{isSpectator?<div className="host-hint">You watched this match as a spectator.</div>:isHost?<button className="primary-button rematch" onClick={playAgain}>PLAY AGAIN <Zap size={17}/></button>:<div className="host-hint">Waiting for the host to start another game.</div>}<button className="text-button" onClick={leaveToHome}>BACK TO HOME</button></motion.section>}
      </AnimatePresence>
      {error&&<div className="toast error-toast" role="alert"><span>!</span>{error}<button onClick={()=>setError('')}>×</button></div>}
      {notice&&<div className="toast notice-toast"><Check size={15}/>{notice}</div>}
    </main>
    <footer className="footer"><span>© 2026 CASH CLASH</span><span>PLAY SHARP. STAY SHARP.</span><span>VIRTUAL CURRENCY · NO REAL-MONEY PLAY</span></footer>
    <AnimatePresence>{rulesOpen&&<motion.div className="modal-backdrop" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={()=>setRulesOpen(false)}><motion.div className="rules-modal" initial={{y:18,opacity:0}} animate={{y:0,opacity:1}} exit={{y:18,opacity:0}} onClick={e=>e.stopPropagation()}><button className="close-target" onClick={()=>setRulesOpen(false)}>×</button><span className="mini-label">THE PLAYBOOK</span><h2>HOW TO <em>CLASH.</em></h2><p>Every player starts with $1,000. Make one secret move every round. Highest balance after 10 rounds wins.</p><div className="rule-item"><Wallet/><div><b>COLLECT <strong>+{room.jackpot?200:100}</strong></b><small>Earn a guaranteed $100.</small></div></div><div className="rule-item"><Swords/><div><b>STEAL <strong>+{room.jackpot?300:150}</strong></b><small>Target one opponent. A successful steal transfers up to $150 from them to you.</small></div></div><div className="rule-item"><Shield/><div><b>PROTECT</b><small>Block every incoming steal attempt this round.</small></div></div><div className="rule-item"><Sparkles/><div><b>POWER-UPS</b><small>Earn Double Steal in round 3 and Spy in round 7. Each is single-use.</small></div></div><div className="rule-item"><Trophy/><div><b>JACKPOT + BOUNTY</b><small>Rounds 5 and 10 pay double. Stealing from the current leader adds a $50 bounty.</small></div></div><div className="rules-foot">15 seconds per round · 10 rounds · 2–8 players · virtual cash only</div><button className="primary-button" onClick={()=>setRulesOpen(false)}>GOT IT <Check size={16}/></button></motion.div></motion.div>}</AnimatePresence>
  </div>;
}

function PlayerCard({player,index,self}) { return <div className={`player-card ${self?'is-self':''}`}><span className="player-avatar">{AVATARS[player.avatar%AVATARS.length]}</span><div className="player-info"><b>{player.name}{self&&<i>YOU</i>}</b><small>{player.isHost?'ROOM HOST':player.isBot?'AI OPPONENT':'READY TO PLAY'}</small></div><span className={`status-dot ${player.connected?'':'offline'}`}/></div>; }
function LeaderRow({player,index,self}) { return <div className={`leader-row ${self?'is-self':''}`}><span className={`rank rank-${index+1}`}>{index===0?<Crown size={15}/>:String(index+1).padStart(2,'0')}</span><span className="leader-avatar">{AVATARS[player.avatar%AVATARS.length]}</span><span className="leader-name">{player.name}{self&&<small>YOU</small>}</span><b className="leader-cash">{money(player.balance)}</b></div>; }

function playGameTone(kind) {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const context = new Audio();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const settings = kind === 'steal' ? [220, 110] : kind === 'block' ? [180, 90] : [880, 1320];
    oscillator.type = kind === 'block' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(settings[0], context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(settings[1], context.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.21);
    oscillator.onended = () => context.close();
  } catch { /* Audio is an enhancement; gameplay must work without it. */ }
}
