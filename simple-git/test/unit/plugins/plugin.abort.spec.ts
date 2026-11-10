import { promiseError } from '@kwsites/promise-result';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitPluginError } from '../../..';
import {
   assertExecutedTasksCount,
   assertGitError,
   createAbortController,
   newSimpleGit,
   theChildProcess,
   wait,
} from '../__fixtures__';
import { mockChildProcessModule } from '../__mocks__/mock-child-process';

describe('plugin.abort', () => {
   let restoreKill: (() => void) | undefined;

   afterEach(() => {
      restoreKill?.();
      restoreKill = undefined;
      vi.unstubAllGlobals();
   });

   it('aborts an active child process', async () => {
      const { controller, abort } = createAbortController();
      const git = newSimpleGit({ abort });

      const queue = promiseError(git.raw('foo'));
      await wait();

      assertExecutedTasksCount(1);
      controller.abort();

      assertGitError(await queue, 'Abort signal received', GitPluginError);
   });

   it('aborts all active promises', async () => {
      const { controller, abort } = createAbortController();
      const git = newSimpleGit({ abort });
      const all = Promise.all([
         git.raw('a').catch((e) => e),
         git.raw('b').catch((e) => e),
         git.raw('c').catch((e) => e),
      ]);

      await wait();
      assertExecutedTasksCount(3);
      controller.abort();

      expect(await all).toEqual([
         expect.any(GitPluginError),
         expect.any(GitPluginError),
         expect.any(GitPluginError),
      ]);
   });

   it('aborts all steps in chained promises', async () => {
      const { controller, abort } = createAbortController();
      const git = newSimpleGit({ abort });
      const a = git.raw('a');
      const b = a.raw('b');
      const c = b.raw('c');

      const all = Promise.all([a.catch((e) => e), b.catch((e) => e), c.catch((e) => e)]);

      await wait();
      assertExecutedTasksCount(1);
      controller.abort();

      expect(await all).toEqual([
         expect.any(GitPluginError),
         expect.any(GitPluginError),
         expect.any(GitPluginError),
      ]);
      assertExecutedTasksCount(1);
   });

   it('aborts before attempting to spawn', async () => {
      const { controller, abort } = createAbortController();
      controller.abort();

      const git = newSimpleGit({ abort });
      assertGitError(await promiseError(git.raw('a')), 'Abort already signaled', GitPluginError);
      assertExecutedTasksCount(0);
   });

   it('handles cancellation while the process is being spawned', async () => {
      const { controller, abort } = createAbortController();
      const error = promiseError(
         newSimpleGit({ abort })
            .outputHandler(() => controller.abort())
            .raw('fetch')
      );

      assertGitError(await error, 'Abort signal received', GitPluginError);
   });

   it('keeps Git in the existing session when an abort signal is supplied', async () => {
      const { controller, abort } = createAbortController();
      const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
      await wait();
      expect(theChildProcess().$options.detached).not.toBe(true);
      controller.abort();
      assertGitError(await error, 'Abort signal received', GitPluginError);
   });

   it('signals only Git descendants, children before parents, on POSIX', async () => {
      usePlatform('linux');
      const { controller, abort } = createAbortController();
      const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
      await wait();
      const git = theChildProcess();
      Object.defineProperty(git, 'pid', { value: 12345 });
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      restoreKill = () => kill.mockRestore();

      controller.abort();

      const listing = mockChildProcessModule.$mostRecent();
      expect(listing.$command).toBe('ps');
      expect(listing.$args).toEqual(['-A', '-o', 'pid=', '-o', 'ppid=']);
      listing.stdout.$emit('data', Buffer.from('12345 1\n12346 12345\n12347 12346\n12348 1\n'));
      listing.$emit('close', 0);
      assertGitError(await error, 'Abort signal received', GitPluginError);
      expect(kill.mock.calls).toEqual([
         [12347, 'SIGINT'],
         [12346, 'SIGINT'],
      ]);
   });

   it('falls back once when process lookup is unavailable on POSIX', async () => {
      usePlatform('linux');
      const { controller, abort } = createAbortController();
      const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
      await wait();
      const git = theChildProcess();
      Object.defineProperty(git, 'pid', { value: 12345 });
      controller.abort();

      const listing = mockChildProcessModule.$mostRecent();
      listing.$emit('error', new Error('ps unavailable'));
      listing.$emit('close', -2);
      assertGitError(await error, 'Abort signal received', GitPluginError);
   });

   it('terminates the Git process tree on Windows', async () => {
      usePlatform('win32');
      const { controller, abort } = createAbortController();
      const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
      await wait();
      const git = theChildProcess();
      Object.defineProperty(git, 'pid', { value: 12345 });

      controller.abort();

      const killer = mockChildProcessModule.$mostRecent();
      expect(killer.$command).toBe('taskkill');
      expect(killer.$args).toEqual(['/PID', '12345', '/T', '/F']);
      expect(killer.$options).toEqual({ stdio: 'ignore', windowsHide: true });
      // taskkill terminates Git before reporting success.
      git.kill();
      killer.$emit('close', 0);
      assertGitError(await error, 'Abort signal received', GitPluginError);
   });

   it('falls back once when taskkill is unavailable on Windows', async () => {
      usePlatform('win32');
      const { controller, abort } = createAbortController();
      const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
      await wait();
      Object.defineProperty(theChildProcess(), 'pid', { value: 12345 });

      controller.abort();

      const killer = mockChildProcessModule.$mostRecent();
      killer.$emit('error', new Error('taskkill unavailable'));
      killer.$emit('close', -2);
      assertGitError(await error, 'Abort signal received', GitPluginError);
   });

   const platforms: NodeJS.Platform[] = ['linux', 'win32'];
   it.each(platforms)(
      'falls back when spawning a process helper throws on %s',
      async (platform) => {
         usePlatform(platform);
         const { controller, abort } = createAbortController();
         const error = promiseError(newSimpleGit({ abort }).raw('fetch'));
         await wait();
         Object.defineProperty(theChildProcess(), 'pid', { value: 12345 });
         mockChildProcessModule.spawn.mockImplementationOnce(() => {
            throw new Error('spawn EPERM');
         });

         controller.abort();

         assertGitError(await error, 'Abort signal received', GitPluginError);
      }
   );
});

function usePlatform(platform: NodeJS.Platform) {
   vi.stubGlobal(
      'process',
      new Proxy(process, {
         get(target, key, receiver) {
            return key === 'platform' ? platform : Reflect.get(target, key, receiver);
         },
      })
   );
}
