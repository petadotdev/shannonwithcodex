import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function getMountedCodexHome(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || '/tmp', '.codex');
}

export function getMountedCodexAuthFile(): string {
  return path.join(getMountedCodexHome(), 'auth.json');
}

export async function createTemporaryCodexHome(configToml?: string): Promise<{
  codexHome: string;
  cleanup: () => Promise<void>;
}> {
  const authFile = getMountedCodexAuthFile();
  const tempCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shannon-codex-'));

  if (await pathExists(authFile)) {
    const authData = await fs.readFile(authFile);
    await fs.writeFile(path.join(tempCodexHome, 'auth.json'), authData, { mode: 0o600 });
  }

  if (configToml !== undefined) {
    await fs.writeFile(path.join(tempCodexHome, 'config.toml'), configToml, 'utf8');
  }

  return {
    codexHome: tempCodexHome,
    cleanup: async () => {
      await fs.rm(tempCodexHome, { recursive: true, force: true });
    },
  };
}
