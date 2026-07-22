# Carpo

Carpo organizes reusable source videos and the clips rendered from them. Videos and clips persist until the user explicitly deletes them.

## Language

**Video**:
A YouTube reference or uploaded original that can produce one or more clips. A video and, for uploads, its original file remain available until explicitly deleted.
_Avoid_: Project, folder, source asset

**Clip**:
A rendered excerpt associated with exactly one video. Deleting a clip does not affect its video or sibling clips.
_Avoid_: Video, project output

**Archived Video**:
A video hidden from the default library view while its original and clips remain retained and reusable.
_Avoid_: Closed project, inactive video

**Delete Video**:
An explicit destructive action that removes the video, its retained uploaded original, and every associated clip.
_Avoid_: Archive, remove from library
