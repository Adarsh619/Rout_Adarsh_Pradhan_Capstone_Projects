// "1 order", "3 orders": a count with its noun in the right number (plural defaults to noun + "s").
export const plural = (n: number, noun: string, many = `${noun}s`) => `${n} ${n === 1 ? noun : many}`;
