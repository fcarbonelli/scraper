/**
 * Identity of a physical branch, ignoring case and extra spaces.
 * Two visits with the same key and the same chain are the same PDV.
 */
export function branchKey(localidad: string | null, direccion: string | null): string {
  const norm = (s: string | null) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${norm(localidad)}\u0000${norm(direccion)}`;
}
