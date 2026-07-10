export interface IssueComment {
  authorLogin: string | null;
  createdAt: string;
  body: string;
}

export interface IssueRecord {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  authorLogin: string | null;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  body: string;
  comments: IssueComment[];
}
