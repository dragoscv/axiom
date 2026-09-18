/**
 * `.axm` v2 CST parser — one rule per EBNF production (docs/design/v2-architecture.md §6).
 *
 *   File        = Header, { Statement } ;
 *   Header      = "axiom", Version ;                Version = '"2"'
 *   Statement   = PlanDecl ;
 *   PlanDecl    = "plan", Ident, "{", { PlanItem } "}" ;
 *   PlanItem    = "intent" String | "profile" Ident | "capabilities" "[" [Cap {"," Cap}] "]"
 *               | "artifact" String ArtifactBody | "check" Ident "using" QualIdent [Json] | "meta" Json ;
 *   ArtifactBody= "{", { "mode" Mode | "op" Op | Source }, "}" ;
 *   Source      = "inline" HereDoc | "template" QualIdent String [Json] | "cas" Digest | "ref" String Digest ;
 *   QualIdent   = Ident, { ".", Ident } ;
 */
import { CstParser, type IToken } from "chevrotain";
import * as T from "./lexer.js";

export class AxmParser extends CstParser {
  constructor() {
    super(T.allTokens, { recoveryEnabled: true, nodeLocationTracking: "full" });
    this.performSelfAnalysis();
  }

  public file = this.RULE("file", () => {
    this.SUBRULE(this.header);
    this.MANY(() => this.SUBRULE(this.planDecl));
  });

  public header = this.RULE("header", () => {
    this.CONSUME(T.Axiom);
    this.CONSUME(T.StringLit, { LABEL: "version" });
  });

  public planDecl = this.RULE("planDecl", () => {
    this.CONSUME(T.Plan);
    this.CONSUME(T.IdentLike, { LABEL: "name" });
    this.CONSUME(T.LCurly);
    this.MANY(() => this.SUBRULE(this.planItem));
    this.CONSUME(T.RCurly);
  });

  public planItem = this.RULE("planItem", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.intentItem) },
      { ALT: () => this.SUBRULE(this.profileItem) },
      { ALT: () => this.SUBRULE(this.capabilitiesItem) },
      { ALT: () => this.SUBRULE(this.artifactItem) },
      { ALT: () => this.SUBRULE(this.checkItem) },
      { ALT: () => this.SUBRULE(this.metaItem) },
    ]);
  });

  public intentItem = this.RULE("intentItem", () => {
    this.CONSUME(T.Intent);
    this.CONSUME(T.StringLike, { LABEL: "value" });
  });

  public profileItem = this.RULE("profileItem", () => {
    this.CONSUME(T.Profile);
    this.CONSUME(T.IdentLike, { LABEL: "value" });
  });

  public capabilitiesItem = this.RULE("capabilitiesItem", () => {
    this.CONSUME(T.Capabilities);
    this.CONSUME(T.LBracket);
    this.MANY_SEP({
      SEP: T.Comma,
      DEF: () => this.CONSUME(T.IdentLike, { LABEL: "cap" }),
    });
    this.CONSUME(T.RBracket);
  });

  public artifactItem = this.RULE("artifactItem", () => {
    this.CONSUME(T.Artifact);
    this.CONSUME(T.StringLike, { LABEL: "path" });
    this.SUBRULE(this.artifactBody);
  });

  public artifactBody = this.RULE("artifactBody", () => {
    this.CONSUME(T.LCurly);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.modeField) },
        { ALT: () => this.SUBRULE(this.opField) },
        { ALT: () => this.SUBRULE(this.source) },
      ]);
    });
    this.CONSUME(T.RCurly);
  });

  public modeField = this.RULE("modeField", () => {
    this.CONSUME(T.ModeKw);
    this.CONSUME(T.IdentLike, { LABEL: "value" });
  });

  public opField = this.RULE("opField", () => {
    this.CONSUME(T.OpKw);
    this.CONSUME(T.OpValue, { LABEL: "value" });
  });

  public source = this.RULE("source", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.inlineSource) },
      { ALT: () => this.SUBRULE(this.templateSource) },
      { ALT: () => this.SUBRULE(this.casSource) },
      { ALT: () => this.SUBRULE(this.refSource) },
    ]);
  });

  public inlineSource = this.RULE("inlineSource", () => {
    this.CONSUME(T.Inline);
    this.CONSUME(T.HereDoc, { LABEL: "content" });
  });

  public templateSource = this.RULE("templateSource", () => {
    this.CONSUME(T.Template);
    this.SUBRULE(this.qualIdent, { LABEL: "emitter" });
    this.CONSUME(T.StringLike, { LABEL: "template" });
    this.OPTION(() => this.CONSUME(T.JsonBlock, { LABEL: "params" }));
  });

  public casSource = this.RULE("casSource", () => {
    this.CONSUME(T.Cas);
    this.CONSUME(T.Digest, { LABEL: "digest" });
  });

  public refSource = this.RULE("refSource", () => {
    this.CONSUME(T.Ref);
    this.CONSUME(T.StringLike, { LABEL: "uri" });
    this.CONSUME(T.Digest, { LABEL: "digest" });
  });

  public checkItem = this.RULE("checkItem", () => {
    this.CONSUME(T.Check);
    this.CONSUME(T.IdentLike, { LABEL: "id" });
    this.CONSUME(T.Using);
    this.SUBRULE(this.qualIdent, { LABEL: "predicate" });
    this.OPTION(() => this.CONSUME(T.JsonBlock, { LABEL: "params" }));
  });

  public metaItem = this.RULE("metaItem", () => {
    this.CONSUME(T.Meta);
    this.CONSUME(T.JsonBlock, { LABEL: "value" });
  });

  public qualIdent = this.RULE("qualIdent", () => {
    this.CONSUME(T.IdentLike, { LABEL: "part" });
    this.MANY(() => {
      this.CONSUME(T.Dot);
      this.CONSUME2(T.IdentLike, { LABEL: "part" });
    });
  });
}

/** Single shared instance — Chevrotain parsers are expensive to construct and safe to reuse. */
export const axmParser: AxmParser = new AxmParser();

export type { IToken };
