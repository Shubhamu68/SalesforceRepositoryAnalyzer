/** Bounded opt-in tuning; invalid values retain the conservative defaults.
 * Read at construction, so all consumers of a shared gateway share one limit. */
export function boundedConcurrency(value:string|undefined,fallback:number,max:number):number{
  if(!value||!/^\d+$/.test(value.trim()))return fallback;
  const n=Number(value);
  return Number.isInteger(n)&&n>=1&&n<=max?n:fallback;
}
