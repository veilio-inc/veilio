/** Matching steps one anonymize call may spend over all its rules and names
 *  (security audit: hostile rules over 5000 names took seconds). Past it,
 *  every test answers "no match", and the call says so. */
export declare const RULE_WORK_BUDGET = 50000000;
/** A per-call allowance of matching steps, shared by every rule and name. */
export interface RuleBudget {
    left: number;
    spent: boolean;
}
/** What the CLI, the MCP and the guard say when `rulesStopped` is set. */
export declare const RULES_STOPPED_NOTE = "custom rules stopped matching: too much work. Names after that point were masked as usual, and no rule kept one readable or gave it a rule placeholder.";
export declare function ruleBudget(steps?: number): RuleBudget;
export interface RuleMatcher {
    /** RegExp.prototype.test's answer, in time linear in the name's length.
     *  Never throws. With a budget: steps are taken from it, and once it is
     *  spent the answer is false. */
    test(name: string, budget?: RuleBudget): boolean;
}
/** Compile a custom rule's pattern, or null when it is outside the language
 *  this matcher runs (see the top of this file). */
export declare function compileRulePattern(pattern: string): RuleMatcher | null;
