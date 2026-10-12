import { FxPreview } from './FxPreview';

/** Build-gated Input adapter; the shared editor displays engine acknowledgments. */
export function InputFxPreview(
  props: Omit<Parameters<typeof FxPreview>[0], 'scope' | 'notice'>,
) {
  return (
    <FxPreview
      {...props}
      scope={0}
      notice={
        <p>
          Preview only: ZIP preserves FX; recovery does not yet preserve FX.
          Keep portable backups of recordings.
        </p>
      }
    />
  );
}
