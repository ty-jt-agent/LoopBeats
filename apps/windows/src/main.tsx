import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../web/src/App';
import { WindowsAudioApplication } from './windows-audio-application';
import { WindowsSessionFiles } from './WindowsSessionFiles';
import '../../web/src/styles.css';

const audioApplication = new WindowsAudioApplication();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      audio={audioApplication}
      sessionFiles={(props) => (
        <WindowsSessionFiles audio={audioApplication} {...props} />
      )}
    />
  </StrictMode>,
);

if (import.meta.env.VITE_WINDOWS_SHELL_SMOKE === 'true')
  void audioApplication.start();
