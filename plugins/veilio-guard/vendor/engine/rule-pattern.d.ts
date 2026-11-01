export interface RuleMatcher {
    /** RegExp.prototype.test's answer, in time linear in the name's length.
     *  Never throws. */
    test(name: string): boolean;
}
/** Compile a custom rule's pattern, or null when it is outside the language
 *  this matcher runs (see the top of this file). */
export declare function compileRulePattern(pattern: string): RuleMatcher | null;
