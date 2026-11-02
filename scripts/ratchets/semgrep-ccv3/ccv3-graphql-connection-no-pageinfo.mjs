// Semgrep test fixture. This code is wrong on purpose: it holds GraphQL selections that
// rule ccv3-graphql-connection-no-pageinfo must flag, next to the selections it must accept.
// Each annotation sits on the line above the matched line.

// ruleid: ccv3-graphql-connection-no-pageinfo
export const BAD_EDITS = 'query{pullRequest{userContentEdits(first:20){nodes{editor{login}}}}}';

// ruleid: ccv3-graphql-connection-no-pageinfo
export const BAD_SPACED = 'query{pullRequest{reviewThreads(first: 100) { nodes{isResolved}}}}';

// ok: ccv3-graphql-connection-no-pageinfo
export const GOOD_EDITS = 'query{pullRequest{userContentEdits(first:20){pageInfo{hasNextPage} nodes{editor{login}}}}}';

// ok: ccv3-graphql-connection-no-pageinfo
export const GOOD_COUNT = 'query{pullRequest{allCommits: commits(first:100){totalCount nodes{commit{oid}}}}}';

// ok: ccv3-graphql-connection-no-pageinfo
export const GOOD_LAST = 'query{pullRequest{commits(last:1){nodes{commit{oid}}}}}';

// nosemgrep: ccv3-graphql-connection-no-pageinfo
export const SUPPRESSED = 'query{pullRequest{labels(first:5){nodes{name}}}}';
