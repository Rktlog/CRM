import { TextareaHTMLAttributes, useEffect, useRef, useState } from 'react';
import { createDictation, getRecognition, DictationState } from '../lib/dictation';

// A text box with a microphone button for voice typing. Press the microphone and talk: the words are typed in as you
// speak. Press it again to stop, or just click in the box to start editing. After that it is an ordinary text box.
// Works where the browser has speech recognition (Chrome, Edge, Safari); elsewhere the button is greyed out.

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void };

export default function DictationTextarea({ value, onChange, style, onFocus, ...rest }: Props) {
  const [state, setState] = useState<DictationState>({ listening: false, error: null });
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

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {state.listening && <style>{'@keyframes dictationPulse{0%{box-shadow:0 0 0 0 rgba(190,60,40,.55)}100%{box-shadow:0 0 0 10px rgba(190,60,40,0)}}'}</style>}
      <textarea
        {...rest}
        value={value}
        onChange={e => onChange(e.target.value)}
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
    </div>
  );
}