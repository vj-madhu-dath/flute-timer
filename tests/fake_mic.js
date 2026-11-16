/*
 * Test-only synthetic microphone.
 *
 * Injected before app.js runs. It replaces getUserMedia with a real
 * MediaStream produced by Web Audio, alternating flute-like tones and a
 * quiet room-tone floor. This avoids operating-system microphone permission
 * prompts in headless test environments while exercising the app's actual
 * AnalyserNode, gate, and lap logic.
 */
(() => {
  if (!navigator.mediaDevices) return;

  const pattern = [
    [0.0, 1.4, 0],
    [2.0, 4.0, 440.0],
    [6.0, 2.8, 0],
    [8.8, 4.0, 523.25],
    [12.8, 2.7, 0],
    [15.5, 3.0, 659.25],
    [18.5, 2.6, 0],
    [21.1, 4.0, 587.33],
    [25.1, 2.4, 0],
    [27.5, 3.2, 783.99],
    [30.7, 2.5, 0],
    [33.2, 4.0, 349.23],
    [37.2, 3.0, 0],
    [40.2, 4.0, 440.0],
    [44.2, 3.0, 0],
  ];

  function makeStream() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const destination = ctx.createMediaStreamDestination();

    // Quiet room tone so the analyser has a realistic floor.
    const frames = Math.floor(ctx.sampleRate * 2);
    const noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < frames; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noiseData[i] = ((seed / 4294967296) * 2 - 1) * 0.0018;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 1;
    noise.connect(noiseGain).connect(destination);
    noise.start();

    // One fundamental and a soft octave harmonic, sharing a breath envelope.
    const fundamental = ctx.createOscillator();
    fundamental.type = 'sine';
    fundamental.frequency.value = 440;
    const harmonic = ctx.createOscillator();
    harmonic.type = 'sine';
    harmonic.frequency.value = 880;
    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.22;
    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    fundamental.connect(envelope);
    harmonic.connect(harmonicGain).connect(envelope);
    envelope.connect(destination);
    fundamental.start();
    harmonic.start();

    let at = ctx.currentTime + 0.05;
    for (const [start, duration, frequency] of pattern) {
      const t = at;
      if (frequency) {
        fundamental.frequency.setValueAtTime(frequency, t);
        harmonic.frequency.setValueAtTime(frequency * 2, t);
        envelope.gain.setValueAtTime(0, t);
        envelope.gain.linearRampToValueAtTime(0.24, t + 0.13);
        envelope.gain.setValueAtTime(0.24, t + duration - 0.16);
        envelope.gain.linearRampToValueAtTime(0, t + duration);
      } else {
        envelope.gain.setValueAtTime(0, t);
      }
      at += duration;
    }

    const stream = destination.stream;
    const track = stream.getAudioTracks()[0];
    try {
      Object.defineProperty(track, 'label', { value: 'Built-in microphone' });
    } catch {
      /* label is only cosmetic */
    }

    // Keep the graph alive for the life of the page.
    window.__fakeMic = window.__fakeMic || [];
    window.__fakeMic.push({ ctx, stream, noise, fundamental, harmonic });
    ctx.resume().catch(() => {});
    return stream;
  }

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.audio) return makeStream();
    throw new DOMException('Only audio is mocked', 'NotFoundError');
  };
})();
