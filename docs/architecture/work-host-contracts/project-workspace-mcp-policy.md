# Project workspace MCP policy

A conversation already marked as project mode is recognized immediately. Other modes need persisted turns; absent history
is not treated as a project. When history exists, the interop adapter translates its mode and project-boundary fields
before Slate decides whether the root conversation belongs to a project.

Project conversations hide tools that can move the project root or create another project. That filtering is applied at
the MCP protocol adapter boundary to the app-control descriptor; unrelated servers and tools remain available. The
shared prompt and tool policy use the same project classification.
