import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoonStar, RotateCcw, Sparkles, Volume2, VolumeX, X } from 'lucide-react';
import styles from './RelaxMoment.module.css';

type Particle = { x:number; y:number; px:number; py:number; vx:number; vy:number; life:number; maxLife:number; color:string; size:number; twinkle:number };
type Flash = { x:number; y:number; life:number; maxLife:number; color:string };
type AudioState = { type:string|null; volume:number; muted:boolean; currentTime:number; duration:number; paused:boolean; ended:boolean };
type KakiAudioManager = {
  play:(type:'relax_fireworks'|'celebration', options?:{ restart?:boolean; volume?:number; onEnded?:()=>void })=>Promise<boolean>;
  stop:(options?:{ fadeMs?:number; reset?:boolean })=>Promise<void>;
  setVolume:(value:number)=>number;
  toggleMute:()=>boolean;
  getState:()=>AudioState;
};
const COLORS = ['#f6d47a', '#e7a84e', '#fff5d5', '#ffd98b', '#c96843'];
const ROCKET_COLORS = ['#f6d47a', '#ffd98b', '#fff5d5'];
const LAUNCH_POSITIONS = [.18, .32, .5, .68, .82];
type Rocket = { x:number; y:number; targetY:number; life:number; maxLife:number; color:string; trail:number };
const sound = () => (window as typeof window & { KakiAudioManager?:KakiAudioManager }).KakiAudioManager;

export function RelaxMoment({ className = '', compact = false, trigger = true }: { className?: string; compact?: boolean; trigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  const [round, setRound] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const initialAudio = sound()?.getState();
  const [muted, setMuted] = useState(Boolean(initialAudio?.muted));
  const [volume, setVolume] = useState(initialAudio?.volume ?? .28);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const finishedRef = useRef(false);
  const fallbackTimerRef = useRef<number | null>(null);

  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  const startRelax = () => {
    finishedRef.current = false;
    setFinished(false);
    setRound((value) => value + 1);
    setOpen(true);
    setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    clearFallbackTimer();
    const played = sound()?.play('relax_fireworks', {
      restart: true,
      volume,
      onEnded: () => {
        finishedRef.current = true;
        setFinished(true);
      }
    });
    // 音频不可用或播放失败时，也要让这场烟花安静收场，而不是永远不停
    void Promise.resolve(played).then((ok) => {
      if (!ok) {
        fallbackTimerRef.current = window.setTimeout(() => {
          finishedRef.current = true;
          setFinished(true);
        }, 48000);
      }
    });
  };
  const closeRelax = () => {
    clearFallbackTimer();
    void sound()?.stop({ fadeMs: 480, reset: true });
    setOpen(false);
  };

  useEffect(() => () => { clearFallbackTimer(); void sound()?.stop({ fadeMs: 420, reset: true }); }, []);

  useEffect(() => {
    const openFromMascot = () => startRelax();
    window.addEventListener('kaki:open-relax', openFromMascot);
    return () => window.removeEventListener('kaki:open-relax', openFromMascot);
  // startRelax deliberately reads the live audio volume; this listener is mounted once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!context) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const particles: Particle[] = [];
    const flashes: Flash[] = [];
    const rockets: Rocket[] = [];
    let frame = 0;
    let previousTime = 0;
    let paletteIndex = 0;
    let launchTimer = 0;
    let nextLaunchMs = 600;
    let launchedCount = 0;
    let disposed = false;
    const lowCoreDevice = (navigator.hardwareConcurrency || 8) <= 4;
    // The scene is atmospheric rather than text-bearing, so a modest internal
    // render scale keeps trails smooth on integrated GPUs while CSS still
    // presents a full-resolution stage.
    const dpr = lowCoreDevice ? .45 : .5;
    const PARTICLE_LIMIT = lowCoreDevice ? 220 : 300;
    const ROCKET_SPEED = lowCoreDevice ? 3.8 : 5.2;

    const resize = () => {
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const launchRocket = () => {
      if (rockets.length > 4 || finishedRef.current) return;
      const x = innerWidth * (LAUNCH_POSITIONS[launchedCount % LAUNCH_POSITIONS.length] + (Math.random() - .5) * .12);
      const targetY = innerHeight * (.22 + Math.random() * .36);
      const color = ROCKET_COLORS[launchedCount % ROCKET_COLORS.length];
      rockets.push({ x, y: innerHeight + 10, targetY, life: 0, maxLife: 42 + Math.random() * 18, color, trail: 0 });
      launchedCount += 1;
    };

    const burst = (x: number, y: number, isMain: boolean) => {
      if (particles.length > PARTICLE_LIMIT - 80) return;
      const count = isMain ? (reduced ? 30 : lowCoreDevice ? 34 : 40) : (reduced ? 14 : lowCoreDevice ? 14 : 18);
      const color = COLORS[paletteIndex % COLORS.length];
      paletteIndex += 1;
      flashes.push({ x, y, life: 0, maxLife: isMain ? 20 : 12, color });
      for (let index = 0; index < count && particles.length < PARTICLE_LIMIT; index += 1) {
        const angle = (Math.PI * 2 * index) / count + Math.random() * .04;
        const spoke = index % 5 === 0 ? 1.35 : index % 3 === 0 ? .65 : 1;
        const speed = (isMain ? 3.5 + Math.random() * 4.5 : 2 + Math.random() * 3) * spoke;
        const life = isMain ? 70 + Math.random() * 30 : 40 + Math.random() * 25;
        particles.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0, maxLife: life, color, size: isMain ? 1.4 + Math.random() * 1.6 : .8 + Math.random() * 1, twinkle: Math.random() * Math.PI * 2 });
      }
    };

    const draw = (time: number) => {
      if (document.hidden) {
        if (!disposed && !reduced) frame = requestAnimationFrame(draw);
        return;
      }
      context.clearRect(0, 0, innerWidth, innerHeight);
      const elapsed = previousTime ? Math.min(50, time - previousTime) : 16.7;
      previousTime = time;

      // A few low-alpha lantern glows keep the night scene alive between
      // bursts (and in reduced-motion mode) at a fixed, tiny draw cost.

      // Launch rockets periodically
      launchTimer += elapsed;
      if (!reduced && !finishedRef.current && launchTimer >= nextLaunchMs) {
        launchTimer = 0;
        const count = 1 + (Math.random() > .7 ? 1 : 0);
        for (let i = 0; i < count; i++) setTimeout(() => launchRocket(), i * 80);
        nextLaunchMs = 500 + Math.random() * 600;
      }

      // Draw rockets with trails
      for (let index = rockets.length - 1; index >= 0; index -= 1) {
        const rocket = rockets[index];
        rocket.life += 1;
        const progress = rocket.life / rocket.maxLife;
        rocket.y -= ROCKET_SPEED * (1 - progress * .3);
        // Trail
        context.globalAlpha = .35;
        context.strokeStyle = '#ffd98b';
        context.lineWidth = 2.2;
        context.beginPath();
        context.moveTo(rocket.x, rocket.y + 3);
        context.lineTo(rocket.x, rocket.y + 16 + progress * 22);
        context.stroke();
        // Rocket head glow
        context.globalAlpha = .72;
        context.fillStyle = rocket.color;
        context.beginPath();
        context.arc(rocket.x, rocket.y, 2.8, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = .45;
        context.fillStyle = '#fff8d9';
        context.beginPath();
        context.arc(rocket.x, rocket.y, 5.5, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
        if (rocket.y <= rocket.targetY || rocket.life >= rocket.maxLife) {
          burst(rocket.x, rocket.y, true);
          if (Math.random() > .55) burst(rocket.x + (Math.random() - .5) * 40, rocket.y + (Math.random() - .5) * 30, false);
          rockets.splice(index, 1);
        }
      }

      // Draw explosion flashes
      context.globalCompositeOperation = 'lighter';
      for (let index = flashes.length - 1; index >= 0; index -= 1) {
        const flash = flashes[index];
        flash.life += 1;
        const progress = flash.life / flash.maxLife;
        const radius = 8 + progress * 56;
        context.globalAlpha = Math.max(0, (1 - progress) * .22);
        context.fillStyle = flash.color;
        context.beginPath();
        context.arc(flash.x, flash.y, radius, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = Math.max(0, (1 - progress) * .58);
        context.fillStyle = '#fff6d4';
        context.beginPath();
        context.arc(flash.x, flash.y, Math.max(2, radius * .15), 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = 1;
        if (flash.life >= flash.maxLife) flashes.splice(index, 1);
      }

      // Update particles first, then batch their trails by visual style. Hundreds
      // of individual beginPath/stroke calls made the full-screen moment miss
      // frames even though no single long task was present.
      const trailBatches = new Map<string, number[]>();
      const sparkleRects: number[] = [];
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += 1;
        particle.px = particle.x;
        particle.py = particle.y;
        particle.vy += .045;
        particle.vx *= .987;
        particle.vy *= .993;
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.y > innerHeight + 20 || particle.x < -20 || particle.x > innerWidth + 20) {
          particles.splice(index, 1);
          continue;
        }
        const alpha = Math.max(0, 1 - particle.life / particle.maxLife) * (.72 + Math.sin(particle.life * .32 + particle.twinkle) * .28);
        const alphaStep = Math.max(.2, Math.ceil(alpha * 5) / 5);
        const widthStep = particle.size < 1.25 ? 1 : particle.size < 2 ? 1.7 : 2.4;
        const batchKey = `${particle.color}|${widthStep}|${alphaStep}`;
        const segments = trailBatches.get(batchKey) || [];
        segments.push(
          particle.px, particle.py,
          particle.x - particle.vx * 3.2, particle.y - particle.vy * 3.2,
        );
        trailBatches.set(batchKey, segments);
        if (particle.life % 4 === 0) {
          const radius = Math.max(.5, particle.size * .38);
          sparkleRects.push(particle.x - radius, particle.y - radius, radius * 2);
        }
        if (particle.life >= particle.maxLife) particles.splice(index, 1);
      }
      for (const [batchKey, segments] of trailBatches) {
        const [color, width, alpha] = batchKey.split('|');
        context.globalAlpha = Number(alpha);
        context.strokeStyle = color;
        context.lineWidth = Number(width);
        context.beginPath();
        for (let index = 0; index < segments.length; index += 4) {
          context.moveTo(segments[index], segments[index + 1]);
          context.lineTo(segments[index + 2], segments[index + 3]);
        }
        context.stroke();
      }
      if (sparkleRects.length) {
        context.globalAlpha = .62;
        context.fillStyle = '#fff8d9';
        context.beginPath();
        for (let index = 0; index < sparkleRects.length; index += 3) {
          const size = sparkleRects[index + 2];
          context.rect(sparkleRects[index], sparkleRects[index + 1], size, size);
        }
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      if (!disposed && !reduced) frame = requestAnimationFrame(draw);
    };

    const onCanvasClick = (event: MouseEvent) => {
      const rx = event.clientX;
      const targetY = event.clientY;
      // 减少动效模式下没有动画循环，点击直接开一朵静止的烟花
      if (reduced) {
        burst(rx, targetY, true);
        draw(0);
        return;
      }
      rockets.push({ x: rx, y: innerHeight + 10, targetY, life: 0, maxLife: 30, color: ROCKET_COLORS[Math.floor(Math.random() * 3)], trail: 0 });
    };

    resize();
    if (reduced) {
      // 减少动效：只画几朵静止的烟花，不起动画循环
      burst(innerWidth * .3, innerHeight * .3, true);
      burst(innerWidth * .62, innerHeight * .24, true);
      burst(innerWidth * .48, innerHeight * .42, false);
      draw(0);
    } else {
      launchRocket();
      frame = requestAnimationFrame(draw);
    }
    addEventListener('resize', resize);
    canvas.addEventListener('click', onCanvasClick);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      removeEventListener('resize', resize);
      canvas.removeEventListener('click', onCanvasClick);
      particles.length = 0;
      flashes.length = 0;
      rockets.length = 0;
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [open, round]);

  return <>
    {trigger && <button type="button" className={`${styles.trigger} ${compact ? styles.compact : ''} ${className}`} onClick={startRelax} data-testid="relax-moment-trigger">
      <MoonStar size={compact ? 16 : 21} /><span>轻松一下</span>{!compact && <small>月下看一场小烟花</small>}
    </button>}
    {open && createPortal(
      <section className={styles.overlay} role="dialog" aria-modal="true" aria-label="轻松一下" data-testid="relax-moment-overlay">
        <div className={styles.sky} aria-hidden="true"><i className={styles.moon} /><i className={styles.cloudOne} /><i className={styles.cloudTwo} /><i className={styles.ridgeFar} /><i className={styles.ridgeNear} /><i className={styles.water} /><i className={styles.lanterns} /></div>
        <canvas ref={canvasRef} className={styles.canvas} aria-label="暖金色烟花，点击任意位置可再放一束" />
        <div className={styles.copy}>
          <Sparkles size={22} />
          <strong>{finished ? '月色安静下来了' : '先歇一小会儿'}</strong>
          <p>{finished ? '这一轮烟花已经落下，想再看一会，或带着这点光继续学习。' : '让音乐和烟花陪你慢一点，再回到刚才的学习位置。'}</p>
          {!finished && !reducedMotion && <small>点击夜空，可以再放一束烟花</small>}
          {!finished && reducedMotion && <small>已按你的系统设置减少动效</small>}
          {finished && <div className={styles.finishActions}><button type="button" onClick={startRelax}><RotateCcw size={15} /> 再看一会</button><button type="button" onClick={closeRelax}>继续学习</button></div>}
        </div>
        <div className={styles.soundControls} aria-label="烟花声音控制">
          <button type="button" onClick={() => setMuted(sound()?.toggleMute() ?? !muted)} aria-label={muted ? '取消静音' : '静音'}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <input type="range" min="0" max="0.35" step="0.01" value={volume} aria-label="烟花音量" onChange={(event) => { const next = Number(event.target.value); setVolume(next); sound()?.setVolume(next); }} />
        </div>
        <button type="button" className={styles.close} onClick={closeRelax} aria-label="结束轻松一下"><X size={19} /> 回到学习</button>
      </section>, document.body)}
  </>;
}
