import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  AudioApplication,
  AudioApplicationSnapshot,
} from '@loopbeats/domain';
import {
  assembleSession,
  type ExportManifest,
} from '@loopbeats/session-format';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { WindowsSessionFiles } from './WindowsSessionFiles';

const manifest: ExportManifest = {
  format: 'LoopBeatsSession',
  version: 2,
  sampleRate: 48_000,
  cycleLengthSamples: 0,
  masterGain: 0.8,
  inputFx: { type: 'None' },
  masterFx: { type: 'None' },
  tracks: [
    {
      id: 0,
      mode: 'OneShot',
      gain: 0.7,
      muted: false,
      lengthSamples: 2,
      audioPath: 'tracks/0.wav',
      fx: { type: 'None' },
    },
    {
      id: 1,
      mode: 'Loop',
      gain: 1,
      muted: false,
      lengthSamples: 0,
      audioPath: null,
      fx: { type: 'None' },
    },
  ],
};

function audioApplication() {
  return {
    getApplicationSnapshot: () =>
      ({
        engine: { tracks: [{ lengthSamples: 0 }, { lengthSamples: 0 }] },
        host: { sampleRate: 48_000 },
      }) as unknown as AudioApplicationSnapshot,
  } as AudioApplication;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('Windows export uses the shared archive encoder and requests only bounded chunks', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:session');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  native.invoke.mockImplementation(async (name: string) => {
    if (name === 'audio_session_export_begin') return { token: 12, manifest };
    if (name === 'audio_session_export_read') return [0.25, -0.5];
    if (name === 'audio_session_export_end') return undefined;
    throw new Error(`Unexpected command ${name}`);
  });
  render(
    <WindowsSessionFiles
      audio={audioApplication()}
      exportEnabled
      importEnabled
      onBusy={() => undefined}
      onStatus={() => undefined}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' }));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('audio_session_export_read', {
      token: 12,
      track: 0,
      offset: 0,
      frames: 2,
    }),
  );
  await waitFor(() =>
    expect(screen.getByText('ZIP download started.')).toBeTruthy(),
  );
  expect(native.invoke).toHaveBeenCalledWith('audio_session_export_end', {
    token: 12,
  });
});

test('Windows import validates with the shared parser before native staging and transfers exact samples', async () => {
  const zip = await assembleSession(
    manifest,
    async () => new Float32Array([0.125, -0.375]),
    () => undefined,
    () => undefined,
  );
  native.invoke.mockImplementation(
    async (name: string, args?: Record<string, unknown>) => {
      if (name === 'audio_session_import_begin') return 19;
      if (name === 'audio_session_import_write') return undefined;
      if (name === 'audio_session_import_commit') return undefined;
      if (name === 'audio_session_cancel') return undefined;
      throw new Error(`Unexpected command ${name}: ${JSON.stringify(args)}`);
    },
  );
  render(
    <WindowsSessionFiles
      audio={audioApplication()}
      exportEnabled
      importEnabled
      onBusy={() => undefined}
      onStatus={() => undefined}
    />,
  );
  const file = new File([await zip.arrayBuffer()], 'session.zip', {
    type: 'application/zip',
  });
  fireEvent.change(screen.getByLabelText('Load ZIP'), {
    target: { files: [file] },
  });

  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('audio_session_import_begin', {
      manifest: expect.objectContaining({ version: 2, sampleRate: 48_000 }),
    }),
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('audio_session_import_write', {
      token: 19,
      track: 0,
      offset: 0,
      samples: [0.125, -0.375],
    }),
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith('audio_session_import_commit', {
      token: 19,
    }),
  );
  expect(
    screen.getByText(
      'Session imported. Recordings are stopped; monitoring is off.',
    ),
  ).toBeTruthy();
});
