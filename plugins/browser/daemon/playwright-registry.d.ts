// playwright-core's browser registry: exported by the package (`./lib/coreBundle`) but untyped.
// Only what chromium.ts uses.
declare module "playwright-core/lib/coreBundle" {
  interface Executable {
    name: string;
    executablePath(): string | undefined;
  }
  export const registry: {
    registry: {
      findExecutable(name: string): Executable | undefined;
      install(
        executables: Executable[],
        options?: { force?: boolean; gc?: boolean },
      ): Promise<void>;
    };
  };
}
