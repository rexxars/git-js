import { type ChildProcess, spawn } from 'node:child_process';

/** Stop Git's transport helpers before terminating their parent. */
export function killProcess(spawned: ChildProcess, killChildren: boolean): void {
   const root = spawned.pid;
   if (!killChildren || !root) {
      spawned.kill('SIGINT');
      return;
   }

   let fallbackUsed = false;
   const fallback = () => {
      if (!fallbackUsed) {
         fallbackUsed = true;
         spawned.kill('SIGINT');
      }
   };

   try {
      if (process.platform !== 'win32') {
         // Keep Git in its existing session so terminal authentication still works.
         const listing = spawn('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
            stdio: ['ignore', 'pipe', 'ignore'],
         });
         let output = '';
         listing.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
         listing.on('error', fallback);
         listing.on('close', (code: number | null) => {
            if (code === 0 && !fallbackUsed) {
               for (const pid of descendants(output, root)) {
                  try {
                     process.kill(pid, 'SIGINT');
                  } catch {
                     // A helper can exit while ps is collecting the process tree.
                  }
               }
            }
            fallback();
         });
         return;
      }

      // Terminate the tree before its parent exits, while taskkill can still find descendants.
      const killer = spawn('taskkill', ['/PID', String(root), '/T', '/F'], {
         stdio: 'ignore',
         windowsHide: true,
      });
      killer.on('error', fallback);
      killer.on('close', (code: number | null) => {
         if (code !== 0) fallback();
      });
   } catch {
      fallback();
   }
}

/** Children before parents, excluding the Git process itself. */
function descendants(output: string, root: number): number[] {
   const children = new Map<number, number[]>();
   for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
   }

   const found = new Set([root]);
   const pending = [root];
   for (const pid of pending) {
      for (const child of children.get(pid) ?? []) {
         if (found.has(child)) continue;
         found.add(child);
         pending.push(child);
      }
   }
   return pending.slice(1).reverse();
}
