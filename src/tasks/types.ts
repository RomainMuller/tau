/** The definition of a task type. */
export interface TaskTypeDefinition {
  readonly description: string;
  /**
   * When true, the work gate blocks the `edit` and `write` tools while a task
   * of this type is the active task.
   */
  readonly readOnly: boolean;
}

/** The task types that tau uses when the configuration does not set them. */
export const DEFAULT_TASK_TYPE_DEFINITIONS: Readonly<Record<string, TaskTypeDefinition>> = {
  plan: { description: "Make or change the task list.", readOnly: false },
  research: { description: "Read code, docs, or the web. No file changes.", readOnly: true },
  code: { description: "Change code or files.", readOnly: false },
  test: { description: "Write or run tests.", readOnly: false },
  review: { description: "Read-only check of work done by other tasks.", readOnly: true },
  docs: { description: "Write documentation.", readOnly: false },
};
