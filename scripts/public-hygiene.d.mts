export function scanPublicText(
  text: string,
  file: string,
  extraBlocked?: string[]
): Array<{ file: string; term: string }>;
export function readPrivateDenylist(file?: string): Promise<string[]>;
export function scanPackageText(
  filesByPath: Record<string, string>,
  extraBlocked?: string[]
): Promise<Array<{ file: string; term: string }>>;
export function shouldScanSourceFile(
  file: string,
  options?: { tracked?: boolean }
): boolean;
export function listSourceFilesForScan(
  root: string,
  options?: {
    listAllFiles?: (root: string) => Promise<string[]>;
    listGitFiles?: (root: string, args: string[]) => Promise<string[] | undefined>;
    warn?: (message: string) => void;
  }
): Promise<string[]>;
