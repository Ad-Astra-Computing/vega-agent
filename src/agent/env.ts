/** A positive number of seconds from the environment, else the fallback. */
export function envSeconds(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
