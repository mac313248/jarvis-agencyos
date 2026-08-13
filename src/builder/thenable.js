// Tiny thenable helper so SQLite stores can stay synchronous while
// PostgreSQL stores return Promises. `await settle(x)` works for both.
// `co()` runs a generator, yielding either values or Promises, and
// returns a plain value when every step is synchronous.

export function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

export function settle(value) {
  return Promise.resolve(value);
}

export function co(generatorFn) {
  const iterator = generatorFn();
  function proceed(next) {
    while (true) {
      if (next.done) return next.value;
      const value = next.value;
      if (isThenable(value)) {
        return value.then(
          (resolved) => proceed(iterator.next(resolved)),
          (err) => {
            try {
              return proceed(iterator.throw(err));
            } catch (thrown) {
              return Promise.reject(thrown);
            }
          }
        );
      }
      next = iterator.next(value);
    }
  }
  try {
    return proceed(iterator.next());
  } catch (err) {
    throw err;
  }
}
