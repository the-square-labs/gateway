package docker

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

var composeServiceFields = map[string]bool{
	"image": true, "environment": true, "command": true, "entrypoint": true, "working_dir": true, "user": true,
	"hostname": true, "ports": true, "healthcheck": true, "depends_on": true, "restart": true, "volumes": true,
	"networks": true, "extra_hosts": true, "labels": true, "cpus": true, "cpu_shares": true, "mem_limit": true,
	"mem_reservation": true, "memswap_limit": true, "pids_limit": true,
}

var composeByteValuePattern = regexp.MustCompile(`(?i)^\d+(?:\.\d+)?(?:[kmgtpe]i?b?|b)?$`)

func validateAndInjectComposeYAML(request *composeRequest) error {
	var document yaml.Node
	if err := yaml.Unmarshal(request.composeYAML, &document); err != nil {
		return errors.New("compose_yaml is invalid")
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return errors.New("compose_yaml must contain one mapping document")
	}
	root := document.Content[0]
	topLevel := mappingValues(root)
	for key := range topLevel {
		switch key {
		case "name", "services", "volumes", "networks", "version":
		default:
			return fmt.Errorf("compose feature %q is not supported", key)
		}
	}
	if name := topLevel["name"]; name != nil {
		if name.Kind != yaml.ScalarNode || name.Value != request.projectName {
			return errors.New("compose document name must match project_name")
		}
	}
	services, ok := topLevel["services"]
	if !ok || services.Kind != yaml.MappingNode || len(services.Content) == 0 {
		return errors.New("compose services are required")
	}
	volumes := topLevel["volumes"]
	networks := topLevel["networks"]
	if volumes != nil && volumes.Kind != yaml.MappingNode {
		return errors.New("compose volumes must be a mapping")
	}
	if networks != nil && networks.Kind != yaml.MappingNode {
		return errors.New("compose networks must be a mapping")
	}
	if err := validateTopLevelResources(volumes, "volume"); err != nil {
		return err
	}
	if err := validateTopLevelResources(networks, "network"); err != nil {
		return err
	}
	for i := 0; i < len(services.Content); i += 2 {
		if err := validateComposeService(services.Content[i].Value, services.Content[i+1], volumes, networks); err != nil {
			return err
		}
		injectComposeLabels(services.Content[i+1], request.projectID, request.configDigest)
	}
	output, err := yaml.Marshal(&document)
	if err != nil {
		return errors.New("normalize compose_yaml")
	}
	request.composeYAML = output
	return nil
}

func validateComposeService(name string, service, volumes, networks *yaml.Node) error {
	if name == "" || service.Kind != yaml.MappingNode {
		return errors.New("compose service definition is invalid")
	}
	values := mappingValues(service)
	image := values["image"]
	if image == nil || image.Kind != yaml.ScalarNode || strings.TrimSpace(image.Value) == "" {
		return errors.New("every compose service requires image")
	}
	for key := range values {
		if !composeServiceFields[key] {
			return fmt.Errorf("compose service feature %q is not supported", key)
		}
	}
	if err := validateServiceLabels(values["labels"]); err != nil {
		return err
	}
	if err := validateServiceVolumes(values["volumes"], volumes); err != nil {
		return err
	}
	if err := validateServiceNetworks(values["networks"], networks); err != nil {
		return err
	}
	if err := validateNonNegativeFloat(values["cpus"], "cpus"); err != nil {
		return err
	}
	if err := validateNonNegativeInteger(values["cpu_shares"], "cpu_shares"); err != nil {
		return err
	}
	if err := validateByteValue(values["mem_limit"], "mem_limit"); err != nil {
		return err
	}
	if err := validateByteValue(values["mem_reservation"], "mem_reservation"); err != nil {
		return err
	}
	if err := validateByteValue(values["memswap_limit"], "memswap_limit", true); err != nil {
		return err
	}
	if err := validatePidsLimit(values["pids_limit"], "pids_limit"); err != nil {
		return err
	}
	return nil
}

func validateNonNegativeFloat(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be a non-negative number", field)
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(node.Value), 64)
	if err != nil || value < 0 {
		return fmt.Errorf("compose service %s must be a non-negative number", field)
	}
	return nil
}

func validateNonNegativeInteger(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be a non-negative integer", field)
	}
	value, err := strconv.ParseInt(strings.TrimSpace(node.Value), 10, 64)
	if err != nil || value < 0 {
		return fmt.Errorf("compose service %s must be a non-negative integer", field)
	}
	return nil
}

func validatePidsLimit(node *yaml.Node, field string) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("compose service %s must be -1 or a positive integer", field)
	}
	value, err := strconv.ParseInt(strings.TrimSpace(node.Value), 10, 64)
	if err != nil || value == 0 || value < -1 {
		return fmt.Errorf("compose service %s must be -1 or a positive integer", field)
	}
	return nil
}

func validateByteValue(node *yaml.Node, field string, allowUnlimited ...bool) error {
	if node == nil {
		return nil
	}
	if len(allowUnlimited) > 0 && allowUnlimited[0] && strings.TrimSpace(node.Value) == "-1" {
		return nil
	}
	if node.Kind != yaml.ScalarNode || !composeByteValuePattern.MatchString(strings.TrimSpace(node.Value)) {
		return fmt.Errorf("compose service %s must be a byte value", field)
	}
	return nil
}

func validateTopLevelResources(node *yaml.Node, resource string) error {
	if node == nil {
		return nil
	}
	for i := 0; i < len(node.Content); i += 2 {
		definition := node.Content[i+1]
		if definition.Kind == yaml.ScalarNode && definition.Tag == "!!null" {
			continue
		}
		if definition.Kind != yaml.MappingNode {
			return fmt.Errorf("compose %s definition is invalid", resource)
		}
		for key, value := range mappingValues(definition) {
			if key != "external" && key != "name" && key != "driver" && key != "labels" {
				return fmt.Errorf("compose %s feature %q is not supported", resource, key)
			}
			if key == "external" && (value.Kind != yaml.ScalarNode || (value.Value != "true" && value.Value != "false")) {
				return fmt.Errorf("compose %s external must be boolean", resource)
			}
			if (key == "name" || key == "driver") && value.Kind != yaml.ScalarNode {
				return fmt.Errorf("compose %s %s must be a string", resource, key)
			}
			if key == "labels" {
				if err := validateServiceLabels(value); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func validateServiceVolumes(node, topLevel *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind != yaml.SequenceNode {
		return errors.New("compose service volumes must be a list")
	}
	known := mappingValues(topLevel)
	for _, entry := range node.Content {
		if entry.Kind == yaml.ScalarNode {
			source := strings.Split(entry.Value, ":")[0]
			if source == "" || strings.HasPrefix(source, "/") || strings.HasPrefix(source, ".") || strings.HasPrefix(source, "~") || strings.ContainsAny(source, `\\$`) || known[source] == nil {
				return errors.New("host bind mounts and unnamed volumes are not supported")
			}
			continue
		}
		if entry.Kind != yaml.MappingNode {
			return errors.New("compose service volume is invalid")
		}
		values := mappingValues(entry)
		if values["type"] == nil || values["type"].Value != "volume" || values["source"] == nil || strings.ContainsAny(values["source"].Value, `\\$`) || known[values["source"].Value] == nil {
			return errors.New("host bind mounts and unnamed volumes are not supported")
		}
		for key := range values {
			if key != "type" && key != "source" && key != "target" && key != "read_only" && key != "volume" {
				return fmt.Errorf("compose service volume feature %q is not supported", key)
			}
		}
	}
	return nil
}

func validateServiceNetworks(node, topLevel *yaml.Node) error {
	if node == nil {
		return nil
	}
	known := mappingValues(topLevel)
	if node.Kind == yaml.SequenceNode {
		for _, entry := range node.Content {
			if entry.Kind != yaml.ScalarNode || known[entry.Value] == nil {
				return errors.New("compose service network is not declared")
			}
		}
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return errors.New("compose service networks are invalid")
	}
	for name, definition := range mappingValues(node) {
		if known[name] == nil || (definition.Kind != yaml.MappingNode && !(definition.Kind == yaml.ScalarNode && definition.Tag == "!!null")) {
			return errors.New("compose service network is not declared")
		}
	}
	return nil
}

func validateServiceLabels(node *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.SequenceNode {
		content := make([]*yaml.Node, 0, len(node.Content)*2)
		for _, entry := range node.Content {
			if entry.Kind != yaml.ScalarNode || !strings.Contains(entry.Value, "=") {
				return errors.New("compose labels must be a mapping or KEY=value list")
			}
			parts := strings.SplitN(entry.Value, "=", 2)
			content = append(content,
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: parts[0]},
				&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: parts[1]},
			)
		}
		node.Kind = yaml.MappingNode
		node.Tag = "!!map"
		node.Content = content
	}
	if node.Kind != yaml.MappingNode {
		return errors.New("compose labels must be a mapping or KEY=value list")
	}
	for key := range mappingValues(node) {
		if strings.HasPrefix(key, "com.docker.compose.") || strings.HasPrefix(key, "wiolett.gateway.compose.") {
			return errors.New("compose labels may not override reserved ownership labels")
		}
	}
	return nil
}

func injectComposeLabels(service *yaml.Node, projectID, digest string) {
	values := mappingValues(service)
	labels := values["labels"]
	if labels == nil {
		service.Content = append(service.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "labels"}, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
		labels = service.Content[len(service.Content)-1]
	}
	labels.Content = append(labels.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "wiolett.gateway.compose.managed"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "true"},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "wiolett.gateway.compose.project-id"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: projectID},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "wiolett.gateway.compose.revision"}, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: digest},
	)
}

func mappingValues(node *yaml.Node) map[string]*yaml.Node {
	values := make(map[string]*yaml.Node)
	if node == nil || node.Kind != yaml.MappingNode {
		return values
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		values[node.Content[i].Value] = node.Content[i+1]
	}
	return values
}
