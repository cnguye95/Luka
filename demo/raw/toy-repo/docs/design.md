# Design notes

The ranking is deliberately boring: exact power iteration over an undirected,
degree-normalized adjacency matrix, with a fixed node order so two runs on the
same graph agree bit for bit.

Nothing is cached to disk. The graph is rebuilt in memory at load and after
each compile, which keeps the only source of truth the vault itself.
