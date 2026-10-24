export const SESSION_AUDIO_BYTES = 92160000;
const IMPORT_MEMORY_BYTES = 384 * 1024 * 1024;

/** Includes the preallocated staging bank and operation-specific scratch space. */
export function fitsImportMemory(
  archiveBytes: number,
  rate: number,
  scratchBytes: number,
) {
  return (
    archiveBytes + rate * 60 * 2 * 4.25 + scratchBytes <= IMPORT_MEMORY_BYTES
  );
}
