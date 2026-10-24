import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AudioClient } from '@loopbeats/audio-client';
import './styles.css';

const audioApplication = new AudioClient({
  wasm: `${import.meta.env.BASE_URL}audio/loop-engine.wasm`,
  worklet: `${import.meta.env.BASE_URL}audio/processor.js`,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App audio={audioApplication} web={audioApplication} />
  </StrictMode>,
);
