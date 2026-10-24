"use client";

import { isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { parseMentionHref } from "@/lib/comment-mentions";
import { remarkWorkItemRefs } from "@/lib/work-item-linkify";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { useWorkItemLinkScope } from "@/components/work-item-link-scope";

const PROSE = [
  "min-w-0 text-sm leading-relaxed break-words",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2 [&_p]:whitespace-pre-line",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_li>ul]:my-1 [&_li>ol]:my-1",
  "[&_input[type=checkbox]]:mr-1.5 [&_li:has(input)]:list-none [&_li:has(input)]:-ml-5",
  "[&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-default [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary",
  "[&_code]:rounded [&_code]:bg-surface-inset [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-inset [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs",
  "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-default [&_th]:bg-surface-inset [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-default [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_hr]:my-3 [&_hr]:border-default",
].join(" ");

/** Plain text of a fence's children (react-markdown hands one string child). */
function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** ```mermaid fences render as diagrams; every other <pre> is left to the default. */
// react-markdown also passes the hast `node`; it must not reach the DOM element.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function PreBlock({ children, node: _node, ...rest }: { children?: ReactNode; node?: unknown }) {
  if (isValidElement<{ className?: string; children?: ReactNode }>(children) && /\blanguage-mermaid\b/.test(children.props.className ?? "")) {
    return <MermaidDiagram source={textOf(children.props.children).replace(/\n$/, "")} />;
  }
  return <pre {...rest}>{children}</pre>;
}

function safeUrl(url: string): string {
  // Comment @mentions (see mentionsAsMarkdownLinks) carry an id-only href that is rendered as a chip, never navigated.
  if (parseMentionHref(url)) return url;
  return defaultUrlTransform(url);
}

type LinkRenderer = (props: { href?: string; children?: ReactNode }) => ReactNode;

function DefaultLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  const external = Boolean(href && /^(?:https?:)?\/\//i.test(href));
  return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
}

// Module-level so the renderer identity is stable across renders. react-markdown
// treats a new component function as a new element type and remounts it, which
// for a streaming chat reply would reset any stateful link renderer every chunk.
type ImageRenderer = (props: { src?: string | Blob; alt?: string }) => ReactNode;

const COMPONENTS_BY_LINK = new WeakMap<LinkRenderer, WeakMap<object, Components>>();
/** Stands in for "no image renderer" as a WeakMap key. */
const NO_IMAGE_RENDERER = {};

function componentsFor(Link: LinkRenderer, Image?: ImageRenderer): Components {
  let byImage = COMPONENTS_BY_LINK.get(Link);
  if (!byImage) {
    byImage = new WeakMap();
    COMPONENTS_BY_LINK.set(Link, byImage);
  }
  const key = Image ?? NO_IMAGE_RENDERER;
  let components = byImage.get(key);
  if (!components) {
    components = {
      a: ({ href, children }) => <Link href={href}>{children}</Link>,
      // Images are dropped unless the caller supplies a renderer that vets the source:
      // markdown is often model- or user-authored, and an <img> is a request the browser
      // makes on its own.
      img: Image ? ({ src, alt }) => <Image src={src} alt={alt} /> : () => null,
      pre: PreBlock,
    };
    byImage.set(key, components);
  }
  return components;
}

/**
 * `linkComponent` swaps the renderer for every link (the agent transcript uses it
 * to show Compass entity links as cards). `imageComponent` opts in to images, which
 * are otherwise not rendered at all; it is responsible for restricting the source.
 * Both must be stable, module-level components — not inline functions.
 */
export function MarkdownContent({
  children,
  className,
  linkComponent = DefaultLink,
  imageComponent,
}: {
  children: string | null | undefined;
  className?: string;
  linkComponent?: LinkRenderer;
  imageComponent?: ImageRenderer;
}) {
  // Inside a workspace, display IDs in prose (TASK-12) become links; elsewhere (portal, marketing) text is untouched.
  const scope = useWorkItemLinkScope();
  const remarkPlugins = useMemo(
    () => (scope ? [remarkGfm, [remarkWorkItemRefs, scope] as [typeof remarkWorkItemRefs, typeof scope]] : [remarkGfm]),
    [scope],
  );
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} urlTransform={safeUrl} components={componentsFor(linkComponent, imageComponent)}>
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
