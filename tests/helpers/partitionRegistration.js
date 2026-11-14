// Partition registrations, never assertions or crypto. Across all parts every group runs once.
export function partitionRegistration(test, part = 0, count = 1) {
  if (!Number.isInteger(part) || !Number.isInteger(count) || part < 0 || part >= count)
    throw new Error('Invalid registration partition');
  let index = 0;
  const register = (...args) => {
    if (index++ % count === part) return test(...args);
  };
  register.each = table => {
    const selected = index++ % count === part;
    return selected ? test.each(table) : () => {};
  };
  return register;
}
