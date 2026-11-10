## Using an AbortController to terminate tasks

Use an `AbortController` in the constructor options for `simpleGit` to cancel Git commands and their transport helpers:

Cancellation stops Git's transport helpers before terminating Git itself. On POSIX, `simple-git` uses `ps` to find descendant processes and sends them `SIGINT`. On Windows, it uses `taskkill /T /F` to terminate the process tree. If process lookup or `taskkill` fails, it falls back to signalling the Git process directly. Git stays in its existing session, so supplying an abort signal does not change terminal authentication.

```typescript
import { simpleGit, GitPluginError, type SimpleGit } from 'simple-git';

const controller = new AbortController();

const git: SimpleGit = simpleGit({
   baseDir: '/some/path', 
   abort: controller.signal,
});

try {
  await git.pull();
}
catch (err) {
    if (err instanceof GitPluginError && err.plugin === 'abort') {
        // task failed because `controller.abort` was called while waiting for the `git.pull`
    }
}
```

### Examples:

#### Share AbortController across many instances

Run the same operation against multiple repositories, cancel any pending operations when the first has been completed. 

```typescript
const repos = [
  '/path/to/repo-a',
  '/path/to/repo-b',
  '/path/to/repo-c',
];

const controller = new AbortController();
const result = await Promise.race(
  repos.map(baseDir => simpleGit({ baseDir, abort: controller.signal }).fetch())
);
controller.abort();
```
