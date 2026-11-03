export function sql(strings, ...values) {
  return { strings, values };
}

sql.join = (parts, separator) => ({ parts, separator });
