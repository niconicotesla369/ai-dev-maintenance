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
