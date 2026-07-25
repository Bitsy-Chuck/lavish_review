import { rename, rm, stat, writeFile } from "node:fs/promises";

let temporaryFileId = 0;

export async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    const existingMode = await stat(file)
      .then((metadata) => metadata.mode & 0o777)
      .catch((error) => {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
      });
    await writeFile(temporary, content, existingMode === undefined ? undefined : { mode: existingMode });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
