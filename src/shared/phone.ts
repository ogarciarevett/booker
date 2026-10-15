const VISIBLE_DIGITS = 4;

/**
 * A phone number as the control API shows it: every digit but the last four replaced with `*`
 * (`+15555550100` becomes `+*******0100`), enough to tell providers apart without exposing the
 * number. A number with four digits or fewer is hidden entirely.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/gu, "").length;
  let toHide = digits > VISIBLE_DIGITS ? digits - VISIBLE_DIGITS : digits;
  return phone.replace(/\d/gu, (digit) => {
    if (toHide === 0) return digit;
    toHide -= 1;
    return "*";
  });
}
