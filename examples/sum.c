/* A C unit that exercises the real GCC adapter: it has a warning
 * (unused variable) and no error. */
#include <stdint.h>

int64_t sum(const int64_t *values, int count) {
  int64_t total = 0;
  for (int i = 0; i < count; i++) {
    total += values[i];
  }
  return total;
}

int main(void) {
  int64_t values[3] = {1, 2, 3};
  int64_t unused = 42;
  return (int)sum(values, 3);
}
