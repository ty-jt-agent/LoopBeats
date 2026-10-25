import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../web/src/App';
import { WindowsAudioApplication } from './windows-audio-application';
import '../../web/src/styles.css';

const audioApplication = new WindowsAudioApplication();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App audio={audioApplication} />
  </StrictMode>,
);
