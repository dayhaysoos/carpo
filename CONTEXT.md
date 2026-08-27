# Carpo

Carpo organizes reusable source videos and the clips rendered from them. Videos and clips persist until the user explicitly deletes them.

## Language

**Video**:
A YouTube reference or uploaded original that can produce one or more clips. A video and, for uploads, its original file remain available until explicitly deleted.
_Avoid_: Project, folder, source asset

**Clip**:
A rendered excerpt associated with exactly one video. Deleting a clip does not affect its video or sibling clips.
_Avoid_: Video, project output

**Clip Proposal**:
An agent-suggested excerpt awaiting explicit user review. A clip proposal is not a clip and may be edited or rejected before any clip is created.
_Avoid_: Pending clip, draft clip

**Source Captions**:
Timed text acquired with a video that can seed transcript and caption work. Source captions are input material, not a finished clip's caption output.
_Avoid_: Output captions, closed-caption artifact

**Timed Caption Track**:
An editable, time-aligned sequence of caption cues associated with a video or clip. It is the shared source for open-caption and closed-caption outputs.
_Avoid_: Transcript, caption file

**Overlay Text**:
A single static message displayed throughout a clip without time alignment.
_Avoid_: Caption, subtitle

**Themed Open Captions**:
Timed caption text permanently rendered into a clip's picture using a chosen visual presentation. Viewers cannot turn open captions off.
_Avoid_: TikTok captions, closed captions

**Closed Caption Artifact**:
A toggleable timed-text output associated with a clip rather than permanently rendered into its picture.
_Avoid_: Open captions, overlay text

**Archived Video**:
A video hidden from the default library view while its original and clips remain retained and reusable.
_Avoid_: Closed project, inactive video

**Delete Video**:
An explicit destructive action that removes the video, its retained uploaded original, and every associated clip.
_Avoid_: Archive, remove from library
