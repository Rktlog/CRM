// Voice typing for the log boxes, using the browser's own speech recognition (Chrome, Edge, Safari). The words are
// typed into the box as they are spoken, and it stays an ordinary text box: stop, then edit as you like.
// In Chrome and Edge the browser sends the audio to its speech service to turn it into text. Nothing is sent to the CRM
// but the text you save.

// Adds spoken words to what is already in the box: one space between, a capital at the start of a sentence.
export function joinSpeech(base: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return base;
  const space = base.length > 0 && !/\s$/.test(base) ? ' ' : '';
  const sentenceStart = base.trim() === '' || /[.!?]\s*$/.test(base);
  return base + space + (sentenceStart ? s.charAt(0).toUpperCase() + s.slice(1) : s);
}

export function getRecognition(): any | null {
  const w = (typeof window !== 'undefined' ? window : {}) as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// What to tell the person when the browser stops listening. null = nothing to say (it just went quiet).
export function micMessage(error: string): string | null {
  switch (error) {
    case 'no-speech': case 'aborted': return null;
    case 'not-allowed': case 'service-not-allowed': return 'The microphone is blocked. Allow it for this site in the browser settings, then try again.';
    case 'audio-capture': return 'No microphone was found.';
    case 'network': return 'Voice typing needs an internet connection.';
    default: return `Voice typing stopped (${error}).`;
  }
}

export type DictationState = { listening: boolean; error: string | null };
type Options = {
  Recognition: any; lang?: string;
  getText: () => string; setText: (t: string) => void;
  onState: (s: DictationState) => void;
  now?: () => number;
};

// Keeps listening until stopped: the browser ends a session after a pause, so it is started again by itself.
export function createDictation(o: Options) {
  const now = o.now ?? (() => Date.now());
  let running = false, rec: any = null, base = '', finals = '', restarts: number[] = [];

  const finish = (error: string | null) => { running = false; o.onState({ listening: false, error }); };

  function launch() {
    base = o.getText(); finals = '';
    rec = new o.Recognition();
    rec.lang = o.lang ?? 'en-AU';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finals += t; else interim += t;
      }
      o.setText(joinSpeech(base, finals + interim));
    };
    rec.onerror = (e: any) => {
      const msg = micMessage(e.error);
      if (msg !== null) { finish(msg); try { rec.abort(); } catch { /* already stopped */ } }
    };
    rec.onend = () => {
      if (!running) return;
      const t = now();
      restarts = restarts.filter(x => t - x < 4000).concat(t);
      if (restarts.length > 4) return finish('Voice typing keeps stopping. Try again in a moment.');
      setTimeout(() => { if (running) { try { launch(); } catch { finish('Voice typing could not restart.'); } } }, 200);
    };
    rec.start();
  }

  return {
    start() {
      if (running) return;
      running = true; restarts = [];
      o.onState({ listening: true, error: null });
      try { launch(); } catch { finish('Voice typing could not start.'); }
    },
    stop() {
      if (!running) return;
      finish(null);
      try { rec?.stop(); } catch { /* already stopped */ }
    },
    get listening() { return running; },
  };
}