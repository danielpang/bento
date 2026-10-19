"""The soundtrack: a soft plucked loop under the whole video, plus the
scenes' own sound effects.

    python3 audio.py info.json out.wav

info.json comes from `node render.mjs <scenes> v info info.json`:
{ duration, night: [[a, b], ...], cues: [[t, type, gain, ...args], ...] }.

Cue types and their args:
    click                         a dry tick
    clicks      to, every         ticks from t until `to`
    typing      to, every         random soft ticks, like keys
    pop         midi              a short pitched pop
    pluck       midi, dur         one plucked note
    chime       [midi...], dur    a plucked chord
    thud        hz, dur           a low knock (landings, stamps)
    boing       dur               a springy hop
    whoosh      dur               filtered noise swell (things flying)
    noise       dur, cut, decay   a burst (cracks, crashes, plates)
"""
import json, sys, wave
import numpy as np

SR = 48000
info = json.load(open(sys.argv[1]))
DUR = float(info["duration"])
N = int(SR * DUR)
t = np.arange(N) / SR
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(3)

def mid(m): return 440.0 * 2 ** ((m - 69) / 12)
def env_t(d): return np.arange(int(d * SR)) / SR
def add(sig, start, gain=1.0, pan=0.0):
    i = int(start * SR); j = min(N, i + len(sig))
    if j <= i or i < 0: return
    s = sig[: j - i] * gain
    L[i:j] += s * np.sqrt(0.5 * (1 - pan)); R[i:j] += s * np.sqrt(0.5 * (1 + pan))
def lowpass(x, a):
    y = np.zeros_like(x); acc = 0.0
    for i in range(len(x)): acc += a * (x[i] - acc); y[i] = acc
    return y

def pluck(m, d=0.9):
    tt = env_t(d); f = mid(m)
    e = np.minimum(1, tt / 0.003) * np.exp(-tt * 5.5)
    return (np.sin(2*np.pi*f*tt) + 0.35*np.sin(2*np.pi*2*f*tt)*np.exp(-tt*9) + 0.12*np.sin(2*np.pi*3*f*tt)*np.exp(-tt*14)) * e
def pad(ms, d):
    tt = env_t(d); s = np.zeros(len(tt))
    for m in ms:
        f = mid(m); s += np.sin(2*np.pi*f*tt) + 0.5*np.sin(2*np.pi*f*1.004*tt + 1)
    return s * np.minimum(1, np.minimum(tt / 0.6, (d - tt) / 0.6)).clip(0)
def noise(d, cut, decay):
    tt = env_t(d); return lowpass(rng.standard_normal(len(tt)), cut) * np.exp(-tt * decay)
def thud(f0=110, d=0.4):
    tt = env_t(d); f = f0 * 0.45 + f0 * np.exp(-tt * 25)
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-tt * 10)
def pop(m=84):
    tt = env_t(0.12); f = mid(m) * (1 + 0.6*np.exp(-tt*60))
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-tt * 35)
def boing(d=0.6):
    tt = env_t(d); f = 300 + 250*np.sin(tt*np.pi/d)
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-tt*4) * np.sin(np.pi*tt/d)
def whoosh(d=0.6):
    tt = env_t(d); return lowpass(rng.standard_normal(len(tt)), 0.08) * np.sin(np.pi*tt/d)**2
def click(): return noise(0.03, 0.5, 120)

# Music bed: 96 bpm, one bar per 2.5 s, C Am F G. Night scenes sit an octave lower.
BAR = 2.5; prog = [[60,64,67], [57,60,64], [53,57,60], [55,59,62]]
night = info.get("night", [])
for b in range(int(DUR / BAR) + 1):
    t0 = b * BAR; ch = prog[b % 4]; dark = any(a <= t0 < z for a, z in night)
    add(pad([m - 12 for m in ch] + [ch[0] - 24], BAR + 0.8), t0 - 0.4, 0.010 if dark else 0.008)
    pattern = [0, 2, 1, 2, 0, 2, 1, 2] if b % 2 == 0 else [0, 1, 2, 1, 0, 2, 1, 2]
    for k, idx in enumerate(pattern):
        if t0 + k * BAR / 8 > DUR - 1.0: break
        if rng.random() < 0.18: continue
        m = ch[idx] + (12 if (not dark and k % 4 == 3) else 0) - (12 if dark else 0)
        add(pluck(m, 0.7), t0 + k * BAR / 8, 0.05, -0.3 if k % 2 else 0.3)
    add(thud(70, 0.3), t0, 0.10); add(thud(70, 0.3), t0 + BAR / 2, 0.06)

for cue in info.get("cues", []):
    at, kind, gain, *a = cue
    if kind == "click": add(click(), at, gain)
    elif kind == "clicks":
        for x in np.arange(at, a[0], a[1]): add(click(), x, gain)
    elif kind == "typing":
        for x in np.arange(at, a[0], a[1]):
            if rng.random() < 0.6: add(click(), x, gain, rng.uniform(-0.6, 0.6))
    elif kind == "pop": add(pop(a[0]), at, gain)
    elif kind == "pluck": add(pluck(a[0], a[1]), at, gain)
    elif kind == "chime": add(sum(pluck(m, a[1]) for m in a[0]), at, gain)
    elif kind == "thud": add(thud(a[0], a[1]), at, gain)
    elif kind == "boing": add(boing(a[0]), at, gain)
    elif kind == "whoosh": add(whoosh(a[0]), at, gain)
    elif kind == "noise": add(noise(a[0], a[1], a[2]), at, gain)
    else: raise SystemExit(f"unknown cue type {kind!r} at {at}")

mix = np.stack([L, R], 1)
mix *= np.minimum(1, np.minimum(t / 0.5, (DUR - t) / 1.5)).clip(0)[:, None]
mix /= np.abs(mix).max() / 0.85
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
