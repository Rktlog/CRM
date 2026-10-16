import { TextareaHTMLAttributes, useEffect, useRef, useState } from 'react';
import { createDictation, getRecognition, DictationState } from '../lib/dictation';
import { apiPost } from '../lib/api';

// A text box with a microphone button for voice typing. Press the microphone and talk: the words are typed in as you
// speak. Press it again to stop, or just click in the box to start editing. After that it is an ordinary text box.
// Works where the browser has speech recognition (Chrome, Edge, Safari); elsewhere the button is greyed out.
// Once there is some text, a Tidy button asks Claude to fix spelling, punctuation and speech-to-text slips. It never
// adds anything, and Undo puts back exactly what was there.

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void; tidy?: boolean };

export default function DictationTextarea({ value, onChange, style, onFocus, tidy = true, ...rest }: Props) {
  const [state, setState] = useState<DictationState>({ listening: false, error: null });
  const [tidying, setTidying] = useState(false);
  const [before, setBefore] = useState<string | null>(null);   // what was there before Tidy, for Undo
  const [tidyError, setTidyError] = useState<string | null>(null);
  const valueRef = useRef(value); valueRef.current = value;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const ctl = useRef<ReturnType<typeof createDictation> | null>(null);
  const Recognition = getRecognition();

  const controller = () => {
    if (!ctl.current) ctl.current = createDictation({ Recognition, getText: () => valueRef.current, setText: t => changeRef.current(t), onState: setState });
    return ctl.current;
  };
  useEffect(() => () => { ctl.current?.stop(); }, []);   // stop listening if the box goes away

  const toggle = () => (state.listening ? controller().stop() : controller().start());

  async function tidyUp() {
    if (state.listening) controller().stop();
    setTidying(true); setTidyError(null);
    const original = valueRef.current;
    try {
      const r = await apiPost('/ai/tidy-note', { text: original });
      setBefore(original);
      changeRef.current(r.text);
    } catch (e) {
      setTidyError((e as Error).message);
    } finally {
      setTidying(false);
    }
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {state.listening && <style>{'@keyframes dictationPulse{0%{box-shadow:0 0 0 0 rgba(190,60,40,.55)}100%{box-shadow:0 0 0 10px rgba(190,60,40,0)}}'}</style>}
      <textarea
        {...rest}
        value={value}
        onChange={e => { setBefore(null); onChange(e.target.value); }}
        onFocus={e => { if (state.listening) controller().stop(); onFocus?.(e); }}
        style={{ ...style, width: '100%', boxSizing: 'border-box', paddingRight: 46 }}
      />
      <button
        type="button"
        onClick={toggle}
        disabled={!Recognition}
        aria-pressed={state.listening}
        aria-label={state.listening ? 'Stop voice typing' : 'Start voice typing'}
        title={Recognition ? (state.listening ? 'Stop voice typing' : 'Voice typing: press and talk') : "Voice typing isn't available in this browser. Use Chrome, Edge or Safari."}
        style={{
          position: 'absolute', right: 8, top: 8, width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--line)', cursor: Recognition ? 'pointer' : 'not-allowed',
          background: state.listening ? 'var(--rust)' : 'var(--paper, #fff)', color: state.listening ? '#fff' : 'inherit', opacity: Recognition ? 1 : 0.4, fontSize: 14, lineHeight: 1, padding: 0,
          animation: state.listening ? 'dictationPulse 1.2s infinite' : undefined,
        }}
      >{state.listening ? '■' : '🎤'}</button>
      {state.listening && <div className="acct-region" style={{ marginTop: 4 }}>Listening… press ■ to stop, or click in the box to edit.</div>}
      {state.error && <div className="save-msg err" style={{ marginTop: 4 }}>{state.error}</div>}
      {tidy && !state.listening && (value.trim().length >= 15 || before !== null) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          <button type="button" className="link-btn" disabled={tidying} onClick={tidyUp} title="Fix spelling, punctuation and speech-to-text slips. Nothing is added.">{tidying ? 'Tidying…' : '✨ Tidy'}</button>
          {before !== null && <><span className="acct-region">Tidied.</span><button type="button" className="link-btn" onClick={() => { onChange(before); setBefore(null); }}>Undo</button></>}
        </div>
      )}
      {tidyError && <div className="save-msg err" style={{ marginTop: 4 }}>{tidyError}</div>}
    </div>
  );
}