// A unit emitted by an AI codegen loop. The audit component flags the
// ambient-authority access; the compiler adapters flag the unused binding.
function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

const unused = 42;
globalThis.cache = sum([1, 2, 3]);
