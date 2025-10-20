import fs from "node:fs";
import path from "node:path";

export interface PolicyContext {
  metrics: Record<string, number | boolean | string>;
  artifacts: Array<{ path: string; content?: string }>;
  capabilities: Array<{ kind: string; args?: Array<string | number | boolean>; optional?: boolean }>;
  outRoot?: string;
}

// Tokenizer simple pentru mini-DSL
type Token =
  | { type: 'identifier'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'dot'; value: '.' }
  | { type: 'lparen'; value: '(' }
  | { type: 'rparen'; value: ')' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const char = expr[i];

    // Skip whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Operators
    if (char === '<' && expr[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '<=' });
      i += 2;
      continue;
    }
    if (char === '>' && expr[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '>=' });
      i += 2;
      continue;
    }
    if (char === '=' && expr[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '==' });
      i += 2;
      continue;
    }
    if (char === '!' && expr[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '!=' });
      i += 2;
      continue;
    }
    if (char === '<' || char === '>') {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    // Punctuation
    if (char === '.') {
      tokens.push({ type: 'dot', value: '.' });
      i++;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
      continue;
    }

    // String literals
    if (char === '"' || char === "'") {
      const quote = char;
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        str += expr[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Numbers
    if (/\d/.test(char)) {
      let num = '';
      while (i < expr.length && /[\d.]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // Identifiers and booleans
    if (/[a-zA-Z_]/.test(char)) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i];
        i++;
      }
      if (ident === 'true') {
        tokens.push({ type: 'boolean', value: true });
      } else if (ident === 'false') {
        tokens.push({ type: 'boolean', value: false });
      } else {
        tokens.push({ type: 'identifier', value: ident });
      }
      continue;
    }

    throw new Error(`Unexpected character: ${char}`);
  }

  return tokens;
}

// Evaluare expresii
async function evalExpression(tokens: Token[], ctx: PolicyContext): Promise<any> {
  if (tokens.length === 0) {
    throw new Error("Empty expression");
  }

  // Function calls: identifier.identifier.identifier(args)
  if (tokens[0].type === 'identifier') {
    const parts: string[] = [tokens[0].value];
    let i = 1;

    // Colectează chain-ul de proprietăți
    while (i < tokens.length && tokens[i].type === 'dot') {
      i++; // skip dot
      if (tokens[i]?.type === 'identifier') {
        parts.push(String(tokens[i].value));
        i++;
      }
    }

    // Dacă urmează paranteze, e function call
    if (i < tokens.length && tokens[i].type === 'lparen') {
      i++; // skip (
      const args: any[] = [];

      // Parse arguments (simple: doar string literals pentru acum)
      while (i < tokens.length && tokens[i].type !== 'rparen') {
        if (tokens[i].type === 'string') {
          args.push(tokens[i].value);
          i++;
        } else if (tokens[i].type === 'number') {
          args.push(tokens[i].value);
          i++;
        }
      }

      // Evaluează function call whitelisted
      return await evalFunctionCall(parts, args, ctx);
    }

    // Altfel, e comparație: identifier op value
    if (i < tokens.length && tokens[i].type === 'operator') {
      const leftValue = ctx.metrics[parts[0]];
      const operator = tokens[i].value;
      i++;

      let rightValue: any;
      if (tokens[i].type === 'number') {
        rightValue = tokens[i].value;
      } else if (tokens[i].type === 'boolean') {
        rightValue = tokens[i].value;
      } else if (tokens[i].type === 'string') {
        rightValue = tokens[i].value;
      } else if (tokens[i].type === 'identifier') {
        rightValue = ctx.metrics[String(tokens[i].value)];
      }

      return compareValues(leftValue, String(operator), rightValue);
    }

    // Doar identificator - returnează valoarea
    return ctx.metrics[parts[0]];
  }

  throw new Error(`Cannot evaluate expression: ${JSON.stringify(tokens)}`);
}

function compareValues(left: any, op: string, right: any): boolean {
  switch (op) {
    case '<=': return left <= right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '>': return left > right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: throw new Error(`Unknown operator: ${op}`);
  }
}

async function evalFunctionCall(parts: string[], args: any[], ctx: PolicyContext): Promise<any> {
  const fullPath = parts.join('.');

  // http.healthy(url)
  if (fullPath === 'http.healthy') {
    // Verifică capability
    const hasNetHttp = ctx.capabilities.some(c => c.kind === 'net' && c.args?.includes('http'));
    if (!hasNetHttp) {
      throw new Error("http.healthy requires capability net('http')");
    }

    if (args.length !== 1 || typeof args[0] !== 'string') {
      throw new Error("http.healthy expects one string argument (URL)");
    }

    return await checkHttpHealthy(args[0]);
  }

  // scan.artifacts.no_personal_data()
  if (fullPath === 'scan.artifacts.no_personal_data') {
    // Nu cere capability explicit pentru scan (e implicit că poate scana artefactele generate)
    return await scanArtifactsForPII(ctx);
  }

  throw new Error(`Unknown function: ${fullPath}`);
}

async function checkHttpHealthy(url: string): Promise<boolean> {
  try {
    const http = await import('node:http');
    const https = await import('node:https');

    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, 1000);

      const req = client.request(url, { method: 'HEAD' }, (res: any) => {
        clearTimeout(timeout);
        resolve(res.statusCode ? res.statusCode >= 200 && res.statusCode < 400 : false);
      });

      req.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });

      req.end();
    });
  } catch {
    return false;
  }
}

async function scanArtifactsForPII(ctx: PolicyContext): Promise<boolean> {
  // Heuristici simple pentru detectarea PII
  const piiPatterns = [
    // CNP românesc (13 cifre consecutive)
    /\b[1-9]\d{12}\b/,
    // Email
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    // Telefon (format românesc sau internațional)
    /\b(\+4|0)7\d{8}\b/,
    // Credit card (pattern general)
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    // Pattern pentru "password:", "secret:", "token:" urmat de valori
    /\b(password|secret|token|api[_-]?key)\s*[:=]\s*['"]?[^\s'"]+/i
  ];

  // Dacă avem outRoot, citim artifacts de pe disc
  if (ctx.outRoot) {
    for (const artifact of ctx.artifacts) {
      try {
        const fullPath = path.join(ctx.outRoot, artifact.path);
        if (!fs.existsSync(fullPath)) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');

        for (const pattern of piiPatterns) {
          if (pattern.test(content)) {
            return false; // Found PII
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // Check artifacts cu content în memorie
  for (const artifact of ctx.artifacts) {
    if (artifact.content) {
      for (const pattern of piiPatterns) {
        if (pattern.test(artifact.content)) {
          return false; // Found PII
        }
      }
    }
  }

  return true; // No PII detected
}

export async function evalCheck(ctx: PolicyContext, expr: string): Promise<boolean> {
  try {
    const tokens = tokenize(expr);
    const result = await evalExpression(tokens, ctx);
    return Boolean(result);
  } catch (err: any) {
    throw new Error(`Check evaluation failed: ${err.message}`);
  }
}
