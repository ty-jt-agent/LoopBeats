import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type {
  AudioSnapshot,
  FxConfig,
  FxScope,
  FxSnapshot,
} from '@loopbeats/domain';
import { FxEditor } from './FxEditor';

function makeSnapshot(): AudioSnapshot {
  const slot = (config: FxConfig): FxSnapshot => ({
    config,
    transitioning: false,
    removing: false,
  });
  const bypassed: FxConfig = {
    type: 'LowPass',
    cutoffHz: 21_600,
    bypassed: true,
  };
  return {
    fx: [slot(bypassed), slot(bypassed), slot(bypassed), slot(bypassed)],
    inputDeviceId: null,
    masterGain: 1,
    transport: { running: false, positionSamples: 0, cycleLengthSamples: 0 },
    tracks: [
      {
        gain: 1,
        muted: false,
        mode: 'Loop',
        canSetMode: true,
        canSetLoop: true,
        state: 'Empty',
        capacitySamples: 256,
        captureLimitSamples: 256,
        capturedSamples: 0,
        canRecord: true,
        canPlay: false,
        canStop: false,
        lengthSamples: 0,
        positionSamples: 0,
      },
      {
        gain: 1,
        muted: false,
        mode: 'Loop',
        canSetMode: true,
        canSetLoop: true,
        state: 'Empty',
        capacitySamples: 256,
        captureLimitSamples: 256,
        capturedSamples: 0,
        canRecord: true,
        canPlay: false,
        canStop: false,
        lengthSamples: 0,
        positionSamples: 0,
      },
    ],
    status: 'ready',
    monitoring: false,
    error: null,
    sampleRate: 48_000,
    processedFrames: 0,
    inputLevel: 0,
    outputLevel: 0,
  };
}

function renderEditor(
  snapshot: AudioSnapshot,
  scope: FxScope,
  onConfigChange = vi.fn(),
) {
  render(
    <FxEditor
      onConfigChange={onConfigChange}
      supportedScopes={[0, 1, 2, 3]}
      snapshot={snapshot}
      enabled
      scope={scope}
      intentResetKey={0}
      focusRequest={0}
      onScopeChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onConfigChange;
}

test('cutoff edits preserve an in-flight bypass target', () => {
  const onConfigChange = renderEditor(makeSnapshot(), 0);

  fireEvent.click(screen.getByRole('button', { name: 'Enable Input filter' }));
  fireEvent.change(screen.getByRole('slider', { name: 'Input cutoff' }), {
    target: { value: '700' },
  });

  expect(onConfigChange).toHaveBeenLastCalledWith(0, {
    type: 'LowPass',
    cutoffHz: expect.any(Number),
    bypassed: false,
  });
});

test('a confirmed reset clears canceled FX intent before later edits', () => {
  const snapshot = makeSnapshot();
  const onConfigChange = vi.fn();
  const renderProps = (intentResetKey: number) => (
    <FxEditor
      onConfigChange={onConfigChange}
      supportedScopes={[0, 1, 2, 3]}
      snapshot={snapshot}
      enabled
      scope={0}
      intentResetKey={intentResetKey}
      focusRequest={0}
      onScopeChange={vi.fn()}
      onClose={vi.fn()}
    />
  );
  const { rerender } = render(renderProps(0));

  fireEvent.click(screen.getByRole('button', { name: 'Enable Input filter' }));
  fireEvent.change(screen.getByRole('slider', { name: 'Input cutoff' }), {
    target: { value: '700' },
  });
  rerender(renderProps(1));
  fireEvent.change(screen.getByRole('slider', { name: 'Input cutoff' }), {
    target: { value: '500' },
  });

  expect(onConfigChange).toHaveBeenLastCalledWith(0, {
    type: 'LowPass',
    cutoffHz: expect.any(Number),
    bypassed: true,
  });
});

test('discarding and restarting audio clears canceled FX intent', () => {
  const readySnapshot = makeSnapshot();
  const onConfigChange = vi.fn();
  const renderProps = (snapshot: AudioSnapshot) => (
    <FxEditor
      onConfigChange={onConfigChange}
      supportedScopes={[0, 1, 2, 3]}
      snapshot={snapshot}
      enabled
      scope={0}
      intentResetKey={0}
      focusRequest={0}
      onScopeChange={vi.fn()}
      onClose={vi.fn()}
    />
  );
  const { rerender } = render(renderProps(readySnapshot));

  fireEvent.click(screen.getByRole('button', { name: 'Enable Input filter' }));
  fireEvent.change(screen.getByRole('slider', { name: 'Input cutoff' }), {
    target: { value: '700' },
  });
  rerender(renderProps({ ...readySnapshot, status: 'stopping' }));
  rerender(renderProps(readySnapshot));
  fireEvent.change(screen.getByRole('slider', { name: 'Input cutoff' }), {
    target: { value: '500' },
  });

  expect(onConfigChange).toHaveBeenLastCalledWith(0, {
    type: 'LowPass',
    cutoffHz: expect.any(Number),
    bypassed: true,
  });
});

test('Master FX editor retains Web adapter errors from the master slot', () => {
  const snapshot = {
    ...makeSnapshot(),
    playbackFxErrors: [null, null, 'Master FX transition failed.'],
  };

  renderEditor(snapshot, 3);

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Master FX transition failed.',
  );
});
