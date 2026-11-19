import type { ValueType } from "./index.ts";

/**
 * Curated Scratch 3.0 block table for object-call syntax
 * `Scratch.<category>.<method>(...args)`.
 *
 * `inputs` are positional Scratch input names. `args` gives the TypeScript
 * types of the positional call arguments, in the same order. The last
 * `fieldCount` arguments are static menu fields (string literals) rather
 * than expression inputs. `kind` is command (statement), reporter, or
 * boolean reporter; `returns` is a reporter's TypeScratch type.
 *
 * Input names were cross-checked against the scratch-vm primitive method
 * bodies (`args.NAME`) plus the official Scratch 3 shadow-input names. This is
 * a curated verified subset; any block not here remains available through
 * `Scratch.do` / `Scratch.get` with a literal opcode.
 */
export interface BlockSpec {
  opcode: string;
  category: string;
  method: string;
  inputs: string[];
  args: ValueType[];
  /** Names of trailing static-field arguments (parallel to the last args). */
  fieldNames: string[];
  kind: "command" | "reporter" | "boolean";
  returns?: ValueType;
}

function spec(
  path: string, opcode: string, inputs: string[], args: ValueType[],
  kind: "command" | "reporter" | "boolean", returns?: ValueType, fieldNames: string[] = [],
): [string, BlockSpec] {
  const [category, method] = path.split(".") as [string, string];
  return [path, { opcode, category, method, inputs, args, fieldNames, kind, returns }];
}

export const BLOCK_SPECS: Readonly<Record<string, BlockSpec>> = Object.fromEntries([
  // ---- motion ----
  spec("motion.moveSteps", "motion_movesteps", ["STEPS"], ["number"], "command"),
  spec("motion.turnRight", "motion_turnright", ["DEGREES"], ["number"], "command"),
  spec("motion.turnLeft", "motion_turnleft", ["DEGREES"], ["number"], "command"),
  spec("motion.goToXY", "motion_gotoxy", ["X", "Y"], ["number", "number"], "command"),
  spec("motion.glideSecsToXY", "motion_glidesecstoxy", ["SECS", "X", "Y"], ["number", "number", "number"], "command"),
  spec("motion.setX", "motion_setx", ["X"], ["number"], "command"),
  spec("motion.setY", "motion_sety", ["Y"], ["number"], "command"),
  spec("motion.changeXBy", "motion_changexby", ["DX"], ["number"], "command"),
  spec("motion.changeYBy", "motion_changeyby", ["DY"], ["number"], "command"),
  spec("motion.pointInDirection", "motion_pointindirection", ["DIRECTION"], ["number"], "command"),
  spec("motion.setRotationStyle", "motion_setrotationstyle", [], ["string"], "command", undefined, ["STYLE"]),
  spec("motion.ifOnEdgeBounce", "motion_ifonedgebounce", [], [], "command"),
  spec("motion.xPosition", "motion_xposition", [], [], "reporter", "number"),
  spec("motion.yPosition", "motion_yposition", [], [], "reporter", "number"),
  spec("motion.direction", "motion_direction", [], [], "reporter", "number"),

  // ---- looks ----
  spec("looks.say", "looks_say", ["MESSAGE"], ["string"], "command"),
  spec("looks.sayForSecs", "looks_sayforsecs", ["MESSAGE", "SECS"], ["string", "number"], "command"),
  spec("looks.think", "looks_think", ["MESSAGE"], ["string"], "command"),
  spec("looks.thinkForSecs", "looks_thinkforsecs", ["MESSAGE", "SECS"], ["string", "number"], "command"),
  spec("looks.show", "looks_show", [], [], "command"),
  spec("looks.hide", "looks_hide", [], [], "command"),
  spec("looks.nextCostume", "looks_nextcostume", [], [], "command"),
  spec("looks.nextBackdrop", "looks_nextbackdrop", [], [], "command"),
  spec("looks.setSizeTo", "looks_setsizeto", ["SIZE"], ["number"], "command"),
  spec("looks.changeSizeBy", "looks_changesizeby", ["CHANGE"], ["number"], "command"),
  spec("looks.clearGraphicEffects", "looks_cleargraphiceffects", [], [], "command"),
  spec("looks.goToFrontBack", "looks_gotofrontback", [], ["string"], "command", undefined, ["FRONT_BACK"]),
  spec("looks.goForwardBackwardLayers", "looks_goforwardbackwardlayers", ["NUM"], ["number", "string"], "command", undefined, ["FORWARD_BACKWARD"]),
  spec("looks.switchCostumeTo", "looks_switchcostumeto", ["COSTUME"], ["string"], "command"),
  spec("looks.switchBackdropTo", "looks_switchbackdropto", ["BACKDROP"], ["string"], "command"),
  spec("looks.size", "looks_size", [], [], "reporter", "number"),
  spec("looks.costumeNumberName", "looks_costumenumbername", [], ["string"], "reporter", "string", ["NUMBER_NAME"]),
  spec("looks.backdropNumberName", "looks_backdropnumbername", [], ["string"], "reporter", "string", ["NUMBER_NAME"]),

  // ---- sound ----
  spec("sound.play", "sound_play", [], ["string"], "command", undefined, ["SOUND_MENU"]),
  spec("sound.playUntilDone", "sound_playuntildone", [], ["string"], "command", undefined, ["SOUND_MENU"]),
  spec("sound.stopAllSounds", "sound_stopallsounds", [], [], "command"),
  spec("sound.clearSoundEffects", "sound_cleareffects", [], [], "command"),
  spec("sound.setVolumeTo", "sound_setvolumeto", ["VOLUME"], ["number"], "command"),
  spec("sound.changeVolumeBy", "sound_changevolumeby", ["VOLUME"], ["number"], "command"),
  spec("sound.volume", "sound_volume", [], [], "reporter", "number"),

  // ---- sensing ----
  spec("sensing.resetTimer", "sensing_resettimer", [], [], "command"),
  spec("sensing.setDragMode", "sensing_setdragmode", [], ["string"], "command", undefined, ["DRAG_MODE"]),
  spec("sensing.askAndWait", "sensing_askandwait", ["QUESTION"], ["string"], "command"),
  spec("sensing.touchingObject", "sensing_touchingobject", [], ["string"], "boolean", undefined, ["TOUCHINGOBJECTMENU"]),
  spec("sensing.mouseDown", "sensing_mousedown", [], [], "boolean"),
  spec("sensing.keyPressed", "sensing_keypressed", [], ["string"], "boolean", undefined, ["KEY_OPTION"]),
  spec("sensing.timer", "sensing_timer", [], [], "reporter", "number"),
  spec("sensing.mouseX", "sensing_mousex", [], [], "reporter", "number"),
  spec("sensing.mouseY", "sensing_mousey", [], [], "reporter", "number"),
  spec("sensing.answer", "sensing_answer", [], [], "reporter", "string"),
  spec("sensing.username", "sensing_username", [], [], "reporter", "string"),

  // ---- operators ----
  spec("operators.add", "operator_add", ["NUM1", "NUM2"], ["number", "number"], "reporter", "number"),
  spec("operators.subtract", "operator_subtract", ["NUM1", "NUM2"], ["number", "number"], "reporter", "number"),
  spec("operators.multiply", "operator_multiply", ["NUM1", "NUM2"], ["number", "number"], "reporter", "number"),
  spec("operators.divide", "operator_divide", ["NUM1", "NUM2"], ["number", "number"], "reporter", "number"),
  spec("operators.mod", "operator_mod", ["NUM1", "NUM2"], ["number", "number"], "reporter", "number"),
  spec("operators.random", "operator_random", ["FROM", "TO"], ["number", "number"], "reporter", "number"),
  spec("operators.round", "operator_round", ["NUM"], ["number"], "reporter", "number"),
  spec("operators.join", "operator_join", ["STRING1", "STRING2"], ["string", "string"], "reporter", "string"),
  spec("operators.letterOf", "operator_letter_of", ["LETTER", "STRING"], ["number", "string"], "reporter", "string"),
  spec("operators.length", "operator_length", ["STRING"], ["string"], "reporter", "number"),
  spec("operators.lt", "operator_lt", ["OPERAND1", "OPERAND2"], ["number", "number"], "boolean"),
  spec("operators.gt", "operator_gt", ["OPERAND1", "OPERAND2"], ["number", "number"], "boolean"),
  spec("operators.equals", "operator_equals", ["OPERAND1", "OPERAND2"], ["string", "string"], "boolean"),
  spec("operators.and", "operator_and", ["OPERAND1", "OPERAND2"], ["boolean", "boolean"], "boolean"),
  spec("operators.or", "operator_or", ["OPERAND1", "OPERAND2"], ["boolean", "boolean"], "boolean"),
  spec("operators.not", "operator_not", ["OPERAND"], ["boolean"], "boolean"),
  spec("operators.contains", "operator_contains", ["STRING1", "STRING2"], ["string", "string"], "boolean"),
]);

export function getBlockSpec(path: string): BlockSpec | undefined {
  return BLOCK_SPECS[path];
}
