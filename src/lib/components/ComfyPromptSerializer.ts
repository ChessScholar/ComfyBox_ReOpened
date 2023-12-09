import type ComfyGraph from "$lib/ComfyGraph";
import type { ComfyBackendNode } from "$lib/nodes/ComfyBackendNode";
import type ComfyGraphNode from "$lib/nodes/ComfyGraphNode";
import { GraphInput, GraphOutput, LGraph, LGraphNode, LLink, NodeMode, Subgraph, type SlotIndex } from "@litegraph-ts/core";
import type { SerializedPrompt, SerializedPromptInput, SerializedPromptInputsForNode, SerializedPromptInputsAll, SerializedPromptInputs } from "./ComfyApp";
import type IComfyInputSlot from "$lib/IComfyInputSlot";
import { Reroute } from "@litegraph-ts/nodes-basic";
import { ComfyReroute } from "$lib/nodes";

function isReroute(node: LGraphNode): boolean {
    return node.is(Reroute) || node.is(ComfyReroute)
}

function isGraphInputOutput(node: LGraphNode): boolean {
    return node.is(GraphInput) || node.is(GraphOutput)
}

export function nodeHasTag(node: LGraphNode, tag: string, checkParents: boolean): boolean {
    while (node != null) {
        if ("tags" in node.properties) {
            if (node.properties.tags.indexOf(tag) !== -1)
                return true;
        }

        if (!checkParents) {
            return false;
        }

        // Count parent subgraphs having the tag also.
        node = node.graph?._subgraph_node;
    }

    return false;
}

export function isActiveNode(node: LGraphNode, tag: string | null = null): boolean {
    if (!node)
        return false;

    // Ignore tags on reroutes since they're just movable wires and it defeats
    // the convenience gains to have to set tags for all them
    // Also ignore graph inputs/outputs
    if (!isReroute(node) && !isGraphInputOutput(node) && (tag && !nodeHasTag(node, tag, true))) {
        console.debug("Skipping tagged node", tag, node.properties.tags, node)
        return false;
    }

    if (node.mode !== NodeMode.ALWAYS) {
        // Don't serialize muted nodes
        return false;
    }

    return true;
}

export function isActiveBackendNode(node: LGraphNode, tag: string | null = null): node is ComfyBackendNode {
    if (!(node as any).isBackendNode)
        return false;

    if (!isActiveNode(node, tag))
        return false;

    // Make sure this node is not contained in an inactive subgraph, even if the
    // node itself is considered active
    if (node.graph._is_subgraph) {
        const isInsideDisabledSubgraph = Array.from(node.iterateParentSubgraphNodes()).some(n => !isActiveNode(n, tag))
        if (isInsideDisabledSubgraph)
            return false;
    }

    return true;
}

export type UpstreamResult = [LGraph | null, LLink | null, number | null, LGraphNode | null];

function followSubgraph(subgraph: Subgraph, link: LLink): UpstreamResult {
    if (link.origin_id != subgraph.id)
        throw new Error("Invalid link and graph output!")

    const innerGraphOutput = subgraph.getInnerGraphOutputByIndex(link.origin_slot)
    if (innerGraphOutput == null)
        throw new Error("No inner graph input!")

    const nextLink = innerGraphOutput.getInputLink(0)
    return [innerGraphOutput.graph, nextLink, 0, innerGraphOutput];
}

function followGraphInput(graphInput: GraphInput, link: LLink): UpstreamResult {
    if (link.origin_id != graphInput.id)
        throw new Error("Invalid link and graph input!")

    const outerSubgraph = graphInput.getParentSubgraph();
    if (outerSubgraph == null)
        throw new Error("No outer subgraph!")

    const outerInputIndex = outerSubgraph.inputs.findIndex(i => i.name === graphInput.nameInGraph)
    if (outerInputIndex === -1)
        throw new Error("No outer input slot!")

    const nextLink = outerSubgraph.getInputLink(outerInputIndex)
    return [outerSubgraph.graph, nextLink, outerInputIndex, outerSubgraph];
}

export function getUpstreamLink(parent: LGraphNode, currentLink: LLink): UpstreamResult {
    if (parent.is(Subgraph)) {
        console.debug("FollowSubgraph")
        return followSubgraph(parent, currentLink);
    }
    else if (parent.is(GraphInput)) {
        console.debug("FollowGraphInput")
        return followGraphInput(parent, currentLink);
    }
    else if ("getUpstreamLink" in parent) {
        const link = (parent as ComfyGraphNode).getUpstreamLink();
        return [parent.graph, link, link?.target_slot, parent];
    }
    else if (parent.inputs.length === 1) {
        // Only one input, so assume we can follow it backwards.
        const link = parent.getInputLink(0);
        if (link) {
            return [parent.graph, link, 0, parent]
        }
    }
    console.warn("[graphToPrompt] Frontend node does not support getUpstreamLink", parent.type)
    return [null, null, null, null];
}

export class UpstreamNodeLocator {
    constructor(private isTheTargetNode: (node: LGraphNode, currentLink: LLink) => boolean) {
    }

    /*
     * Traverses the graph upstream from outputs towards inputs across
     * a sequence of nodes dependent on a condition.
     *
     * Returns the node and the output link attached to it that leads to the
     * starting node if any.
     */
    locateUpstream(fromNode: LGraphNode, inputIndex: SlotIndex, tag: string | null): [LGraphNode | null, LLink | null, number | null, LGraphNode | null] {
        let parent = fromNode.getInputNode(inputIndex);
        if (!parent)
            return [null, null, null, null];

        const seen = {}
        let currentLink = fromNode.getInputLink(inputIndex);
        let currentInputSlot = inputIndex;
        let currentNode = fromNode;

        const shouldFollowParent = (parent: LGraphNode, currentLink: LLink) => {
            return isActiveNode(parent, tag) && !this.isTheTargetNode(parent, currentLink);
        }

        // If there are non-target nodes between us and another
        // target node, we have to traverse them first. This
        // behavior is dependent on the type of node. Reroute nodes
        // will simply follow their single input, while branching
        // nodes have conditional logic that determines which link
        // to follow backwards.
        while (shouldFollowParent(parent, currentLink)) {
            const [nextGraph, nextLink, nextInputSlot, nextNode] = getUpstreamLink(parent, currentLink);

            currentInputSlot = nextInputSlot;
            currentNode = nextNode;

            if (nextLink == null) {
                console.warn("[graphToPrompt] No upstream link found in frontend node", parent)
                break;
            }

            if (nextLink && !seen[nextLink.id]) {
                seen[nextLink.id] = true
                const nextParent = nextGraph.getNodeById(nextLink.origin_id);
                if (!isActiveNode(parent, tag)) {
                    parent = null;
                }
                else {
                    console.debug("[graphToPrompt] Traverse upstream link", parent.id, nextParent?.id, (nextParent as any)?.isBackendNode)
                    currentLink = nextLink;
                    parent = nextParent;
                }
            } else {
                parent = null;
            }
        }

        if (!isActiveNode(parent, tag) || !this.isTheTargetNode(parent, currentLink) || currentLink == null)
            return [null, currentLink, currentInputSlot, currentNode];

        return [parent, currentLink, currentInputSlot, currentNode]
    }
}

export default class ComfyPromptSerializer {
    serializeInputValues(node: ComfyBackendNode): SerializedPromptInputs {
        // Store input values passed by frontend-only nodes
        if (!node.inputs) {
            return {}
        }

        const inputs = {}

        for (let i = 0; i < node.inputs.length; i++) {
            const inp = node.inputs[i];
            const inputLink = node.getInputLink(i)
            const inputNode = node.getInputNode(i)

            // We don't check tags for non-backend nodes.
            // Just check for node inactivity (so you can toggle groups of
            // tagged frontend nodes on/off)
            if (inputNode && inputNode.mode !== NodeMode.ALWAYS) {
                console.debug("Skipping inactive node", inputNode)
                continue;
            }

            if (!inputLink || !inputNode) {
                if ("config" in inp) {
                    const defaultValue = (inp as IComfyInputSlot).config?.defaultValue
                    if (defaultValue !== null && defaultValue !== undefined)
                        inputs[inp.name] = defaultValue
                }
                continue;
            }

            let serialize = true;
            if ("config" in inp)
                serialize = (inp as IComfyInputSlot).serialize

            let isBackendNode = node.isBackendNode;
            let isInputBackendNode = false;
            if ("isBackendNode" in inputNode)
                isInputBackendNode = (inputNode as ComfyGraphNode).isBackendNode;

            // The reasoning behind this check:
            // We only want to serialize inputs to nodes with backend equivalents.
            // And in ComfyBox, the backend nodes in litegraph *never* have widgets, instead they're all inputs.
            // All values are passed by separate frontend-only nodes,
            // either UI-bound or something like ConstantInteger.
            // So we know that any value passed into a backend node *must* come from
            // a frontend node.
            // The rest (links between backend nodes) will be serialized after this bit runs.
            if (serialize && isBackendNode && !isInputBackendNode) {
                inputs[inp.name] = inputLink.data
            }
        }

        return inputs
    }

    serializeBackendLinks(node: ComfyBackendNode, tag: string | null): Record<string, SerializedPromptInput> {
        const inputs = {}

        // Find a backend node upstream following before any number of frontend nodes
        const test = (node: LGraphNode) => (node as any).isBackendNode
        const nodeLocator = new UpstreamNodeLocator(test)

        // Store links between backend-only and hybrid nodes
        for (let i = 0; i < node.inputs.length; i++) {
            const [backendNode, linkLeadingTo] = nodeLocator.locateUpstream(node, i, tag)
            if (backendNode) {
                console.debug("[graphToPrompt] final link", backendNode.id, "-->", node.id)
                const input = node.inputs[i]
                if (!(input.name in inputs))
                    inputs[input.name] = [String(linkLeadingTo.origin_id), linkLeadingTo.origin_slot];
            }
            else {
                console.warn("[graphToPrompt] Didn't find upstream link!", node.id, node.type, node.title)
            }
        }

        return inputs
    }

    serialize(graph: ComfyGraph, tag: string | null = null): SerializedPrompt {
        // Run frontend-only logic
        graph.runStep(1)

        const workflow = graph.serialize();

        const output: SerializedPromptInputsAll = {};

        // Process nodes in order of execution
        for (const node of graph.computeExecutionOrderRecursive<ComfyGraphNode>(false, null)) {
            const n = workflow.nodes.find((n) => n.id === node.id);

            if (!isActiveBackendNode(node, tag)) {
                continue;
            }

            const inputs = this.serializeInputValues(node);
            const links = this.serializeBackendLinks(node, tag);

            console.warn("OUTPUT", node.id, node.comfyClass, node.mode)

            output[String(node.id)] = {
                inputs: { ...inputs, ...links },
                class_type: node.comfyClass,
            };
        }

        // Remove inputs connected to removed nodes
        for (const nodeId in output) {
            for (const inputName in output[nodeId].inputs) {
                if (Array.isArray(output[nodeId].inputs[inputName])
                    && output[nodeId].inputs[inputName].length === 2
                    && !output[output[nodeId].inputs[inputName][0]]) {
                    console.debug("Prune removed node link", nodeId, inputName, output[nodeId].inputs[inputName])
                    delete output[nodeId].inputs[inputName];
                }
            }
        }

        // console.debug({ workflow, output })
        // console.debug(promptToGraphVis({ workflow, output }))

        return { workflow, output };
    }
}
