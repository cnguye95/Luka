# Graph-Based Retrieval

Luka answers questions from a wiki it compiles out of the documents you drop
into `raw/`. Retrieval walks the wikilink graph with Personalized PageRank
instead of searching an embedding index, so the mechanism that produced an
answer is something you can look at rather than something you have to trust.

![Figure 1: the compile pipeline](https://luka.invalid/fig1.png)

The figure above is deliberately unreachable. `.invalid` is a reserved
top-level domain that can never resolve, so compiling this corpus always
produces the "image not fetched" marker and leaves the remote link in place.

![](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)

That second reference is a `data:` URI. Localization only touches remote
references, so it comes through untouched.

This file starts with no frontmatter on purpose: compile writes `ingested` and
`source-format` in place, exactly once, and the hash it records is taken after
that write so the next compile sees the file as unchanged.
