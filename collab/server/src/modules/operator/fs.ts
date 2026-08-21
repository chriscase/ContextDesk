import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";

export interface OperatorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  isWritableDirectory(path: string): boolean;
  readFile(path: string): string;
}

export const nodeOperatorFs: OperatorFs = {
  exists(path) {
    return existsSync(path);
  },
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isDirectory(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritableDirectory(path) {
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) return false;
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  readFile(path) {
    return readFileSync(path, "utf8");
  },
};
