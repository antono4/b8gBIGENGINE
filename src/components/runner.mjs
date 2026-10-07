/**
 * Runner component.
 *
 * Loads a binary stack image into a {@link Vm} and executes it. It requires a
 * `vm-heap` capability (a shared-memory region the program may read/write) and
 * a `results` stream. The VM's handle table is exactly this component's own
 * handle bag, so a stack program can only ever touch capabilities the kernel
 * granted to the runner.
 */
export const runnerComponent = {
  name: 'runner',
  version: '0.1.0',
  requires: ['vm-heap', 'results'],
  provides: ['execute'],
  factory(handles, api) {
    const { Vm } = api.vm;

    function execute({ name = 'program', bytes, trace = false, limits }) {
      const vm = new Vm({ bytes, context: api.context, trace, limits });
      const started = Date.now();
      const outcome = vm.run();
      const result = {
        name,
        reason: outcome.reason,
        stack: vm.stack,
        steps: vm.steps,
        durationMs: Date.now() - started,
        output: vm.output,
      };
      handles.results.target.emit({ type: 'vm:run', name, steps: vm.steps, reason: outcome.reason });
      return result;
    }

    return { execute, describe: () => ({ component: 'runner' }) };
  },
};
