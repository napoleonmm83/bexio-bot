// Guard for the read-only /mcp bexio_get tool: only versioned bexio API paths,
// nothing that could escape api.bexio.com or climb out of the version prefix.
export function isAllowedBexioPath(path: string): boolean {
  return /^\/[234]\.0\/[A-Za-z0-9_\-/]+$/.test(path) && !path.includes('..') && !path.includes('//');
}
