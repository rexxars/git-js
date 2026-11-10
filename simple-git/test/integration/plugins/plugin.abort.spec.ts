import { promiseError } from '@kwsites/promise-result';
import { createServer } from 'node:http';
import {
   assertGitError,
   createAbortController,
   createTestContext,
   newSimpleGit,
   type SimpleGitTestContext,
   wait,
} from '@simple-git/test-utils';
import { beforeEach, describe, it } from 'vitest';

import { GitPluginError } from '../../..';

describe('timeout', () => {
   let context: SimpleGitTestContext;

   beforeEach(async () => (context = await createTestContext()));

   it('kills processes on abort signal', async () => {
      const { controller, abort } = createAbortController();

      const threw = promiseError(newSimpleGit(context.root, { abort }).init());

      await wait(0);
      controller.abort();

      assertGitError(await threw, 'Abort signal received', GitPluginError);
   });

   it('closes the HTTP transport connection when a clone is aborted', async () => {
      const requestStarted = Promise.withResolvers<void>();
      const connectionClosed = Promise.withResolvers<void>();
      const server = createServer((_request, response) => {
         response.on('close', () => connectionClosed.resolve());
         requestStarted.resolve();
         // Keep Git's HTTP transport waiting for the smart HTTP response.
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');

      const { controller, abort } = createAbortController();
      const error = promiseError(
         newSimpleGit(context.root, { abort }).clone(
            `http://127.0.0.1:${address.port}/repo.git`,
            context.path('stalled-clone')
         )
      );
      try {
         await withinDeadline(requestStarted.promise);
         controller.abort();
         assertGitError(await withinDeadline(error), 'Abort signal received', GitPluginError);
         await withinDeadline(connectionClosed.promise);
      } finally {
         if (!abort.aborted) controller.abort();
         server.closeAllConnections();
         await new Promise<void>((resolve) => server.close(() => resolve()));
         await error;
      }
   });

   it('share AbortController across many instances', async () => {
      const { controller, abort } = createAbortController();
      const repos = await Promise.all('abcdef'.split('').map((p) => context.dir(p)));
      const requestsStarted = Promise.withResolvers<void>();
      let requests = 0;
      const server = createServer(() => {
         if (++requests === repos.length - 1) requestsStarted.resolve();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const tasks = repos.map((baseDir, index) => {
         const git = newSimpleGit({ baseDir, abort });
         if (index === 0) {
            return promiseError(git.init());
         }
         return promiseError(git.clone(`http://127.0.0.1:${address.port}/repo.git`, baseDir));
      });

      try {
         const initialized = await withinDeadline(tasks[0]);
         if (initialized instanceof Error) throw initialized;
         await withinDeadline(requestsStarted.promise);
         controller.abort();
         for (const error of await withinDeadline(Promise.all(tasks.slice(1)))) {
            assertGitError(error, 'Abort signal received', GitPluginError);
         }
      } finally {
         if (!abort.aborted) controller.abort();
         server.closeAllConnections();
         await new Promise<void>((resolve) => server.close(() => resolve()));
         await Promise.all(tasks);
      }
   });
});

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
      return await Promise.race([
         promise,
         new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Operation did not finish')), 2000);
         }),
      ]);
   } finally {
      clearTimeout(timer);
   }
}
