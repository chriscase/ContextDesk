import path from "node:path";

/**
 * Forbid importing another module's internals. Only `src/modules/<name>/index.ts`
 * is a legal entry. Same-module files may import each other.
 */
export default {
  rules: {
    "no-module-deep-import": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow deep imports across modular-monolith module folders",
        },
        schema: [],
        messages: {
          deep: "Do not deep-import another module's internals ({{from}} → {{to}}). Import only from that module's public index.ts.",
        },
      },
      create(context) {
        const filename = context.filename;
        return {
          ImportDeclaration(node) {
            const spec = node.source.value;
            if (typeof spec !== "string") return;
            const resolved = path.normalize(
              path.join(path.dirname(filename), spec),
            );
            const to = matchModuleFile(resolved);
            if (!to) return;
            if (isIndex(to.rest)) return;
            const from = matchModuleFile(filename);
            if (from && from.module === to.module) return;
            context.report({
              node,
              messageId: "deep",
              data: {
                from: from ? from.module : path.basename(filename),
                to: `${to.module}/${to.rest}`,
              },
            });
          },
        };
      },
    },
  },
};

function matchModuleFile(filePath) {
  const posix = filePath.split(path.sep).join("/");
  const match = /\/src\/modules\/([^/]+)\/(.+)$/.exec(posix);
  if (!match) return null;
  return { module: match[1], rest: match[2] };
}

function isIndex(rest) {
  return /^(index)(\.ts|\.js)?$/.test(rest);
}
